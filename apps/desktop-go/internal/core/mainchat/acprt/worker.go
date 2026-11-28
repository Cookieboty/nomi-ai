package acprt

import (
	"os"
	"strings"
	"sync"
	"time"

	antigravityp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/antigravity"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/google/uuid"
)

// CliTrap hooks spawned ACP subprocesses (nil disables tracing).
var CliTrap func(child clisdk.ChildLike, command string, args []string, tabID string)

type worker struct {
	last                 *turn
	notify               func(cr.Event) error
	onTitle              func(string)
	onMode               func(string)
	onCommands           func([]cr.SlashCommandInfo)
	onModel              func(string, string)
	backendID            string
	child                *nodeproc.Child
	driver               *drivers.AcpDriver
	sid, stderr, failure string
	appliedModel         string
	appliedEffort        string
	effectiveModel       string
	unsupportedModes     map[string]bool
	closed               chan struct{}
	closeOnce            sync.Once
	active               *turn
	completed, stopped   bool
}

func officialLaunchFor(cfg Config) clisdk.AgentLaunch {
	impl := builtin.Impl(cfg.BackendID)
	if impl == nil || impl.Launch.Official == nil {
		return clisdk.AgentLaunch{Env: util.NewObj(), Strip: []string{}}
	}
	var accountDir *string
	if cfg.Source != "local" && (cfg.Source == "official" || builtin.WithAccounts(cfg.BackendID)) && cfg.ConfigDir != "" {
		dir := cfg.ConfigDir
		accountDir = &dir
	}
	var modelPtr *string
	if cfg.Model != "" && cfg.Model != "cli-default" {
		m := cfg.Model
		modelPtr = &m
	}
	return impl.Launch.Official(clisdk.LaunchContext{
		Cwd:            cfg.Cwd,
		PermissionMode: toCliPermissionMode(cfg.PermissionMode),
		Model:          modelPtr,
		AccountDir:     accountDir,
	})
}

func officialArgs(cfg Config) []string {
	args := append([]string{}, builtin.AcpArgs(cfg.BackendID)...)
	if len(cfg.ExtraArgs) > 0 {
		args = append(args, cfg.ExtraArgs...)
	}
	return args
}

func officialEnv(cfg Config) []string {
	drop := map[string]bool{}
	for _, k := range cfg.StripEnv {
		drop[k] = true
	}
	for k := range cfg.ExtraEnv {
		drop[k] = true
	}
	var launchEnv *util.Obj
	if cfg.Source != "thirdParty" {
		launch := officialLaunchFor(cfg)
		for _, k := range launch.Strip {
			drop[k] = true
		}
		if launch.Env != nil {
			for _, k := range launch.Env.Keys() {
				drop[k] = true
			}
			launchEnv = launch.Env
		}
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !drop[key] {
			env = append(env, entry)
		}
	}
	if launchEnv != nil {
		for _, k := range launchEnv.Keys() {
			if _, over := cfg.ExtraEnv[k]; !over {
				env = append(env, k+"="+util.Str(launchEnv.Get(k)))
			}
		}
	}
	for k, v := range cfg.ExtraEnv {
		env = append(env, k+"="+v)
	}
	return env
}

func (r *Runtime) spawn() *worker {
	cfg := r.config
	args := officialArgs(cfg)
	env := officialEnv(cfg)
	w := &worker{
		closed:           make(chan struct{}),
		onTitle:          r.emitTitle,
		onMode:           r.emitMode,
		onCommands:       r.emitCommands,
		onModel:          r.emitModel,
		backendID:        cfg.BackendID,
		unsupportedModes: map[string]bool{},
	}
	w.child = nodeproc.Spawn(cfg.Executable, args, nodeproc.Options{Cwd: cfg.Cwd, Env: env, Detached: true})
	w.child.OnStderr(func(chunk string) {
		if len(w.stderr)+len(chunk) > 8192 {
			w.stderr = "[truncated]"
			return
		}
		w.stderr += chunk
	})
	w.child.OnClose(func(*int, string) { w.closeOnce.Do(func() { close(w.closed) }) })
	child := clisdk.ProcChild{Child: w.child}
	if CliTrap != nil {
		tab := "managed:" + cfg.BackendID
		if r.token.ConversationID != "" {
			tab = "managed:" + r.token.ConversationID
		}
		CliTrap(child, cfg.Executable, args, tab)
	}
	disableElicitation := cfg.BackendID == "antigravity" || cfg.OnQuestion == nil
	driverOpts := drivers.AcpDriverOptions{
		Child:              child,
		Kill:               func(clisdk.ChildLike) { killGroup(w.child.Pid) },
		NewID:              func() string { return uuid.NewString() },
		DisableElicitation: disableElicitation,
	}
	if cfg.BackendID == "antigravity" {
		driverOpts.ClientInfo = antigravityp.ClientInfo()
		driverOpts.ClientCapabilities = antigravityp.ClientCapabilities()
	}
	w.driver = drivers.NewAcpDriver(driverOpts)
	w.driver.On(func(ev clisdk.SessionEvent) {
		if ev == nil || w.failure != "" {
			return
		}
		kind, _ := ev.Get("kind").(string)
		switch kind {
		case "harness":
			w.parsed(util.AsObj(ev.Get("event")))
		case "commands":
			if w.onCommands != nil {
				w.onCommands(parseSlashCommands(ev.Get("commands")))
			}
		case "permission":
			w.onPermission(ev)
		case "question":
			qid := util.Str(ev.Get("id"))
			if cfg.OnQuestion != nil && qid != "" {
				params := util.AsObj(ev.Get("params"))
				cfg.OnQuestion(qid, params, func(body *util.Obj, cancel bool) {
					if w.driver != nil {
						w.driver.RespondQuestion(qid, body, cancel)
					}
				})
				return
			}
			if qid != "" && w.driver != nil {
				w.driver.RespondQuestion(qid, nil, true)
			}
			w.fail("unsupported native question/elicitation")
		}
	})
	return w
}

func parseSlashCommands(raw any) []cr.SlashCommandInfo {
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]cr.SlashCommandInfo, 0, len(arr))
	for _, item := range arr {
		o := util.AsObj(item)
		if o == nil {
			continue
		}
		name := strings.TrimSpace(util.Str(o.Get("name")))
		if name == "" {
			continue
		}
		out = append(out, cr.SlashCommandInfo{
			Name:        name,
			Description: strings.TrimSpace(util.Str(o.Get("description"))),
			Hint:        strings.TrimSpace(util.Str(o.Get("hint"))),
		})
	}
	return out
}

func (w *worker) onPermission(se clisdk.SessionEvent) {
	t := w.active
	if t == nil {
		w.fail("unsolicited native permission outside active turn")
		return
	}
	id := util.Str(se.Get("id"))
	if id == "" {
		w.fail("native permission missing id")
		return
	}
	if _, exists := t.approvals[id]; exists {
		w.fail("duplicate native approval")
		return
	}
	req := util.AsObj(se.Get("request"))
	summary := util.Str(req.Get("summary"))
	toolName := strings.TrimSpace(util.Str(req.Get("toolName")))
	argsPreview := util.Str(req.Get("argsPreview"))
	if summary == "" {
		summary = "tool action"
	}
	if toolName == "" {
		toolName = summary
	}
	var opts []cr.ApprovalOption
	if rawOpts, ok := req.Get("options").([]any); ok {
		for _, rawOpt := range rawOpts {
			o := util.AsObj(rawOpt)
			if o == nil {
				continue
			}
			oid := strings.TrimSpace(util.Str(o.Get("id")))
			if oid == "" {
				continue
			}
			opts = append(opts, cr.ApprovalOption{
				ID:   oid,
				Kind: strings.TrimSpace(util.Str(o.Get("kind"))),
				Name: strings.TrimSpace(util.Str(o.Get("name"))),
			})
		}
	}
	permKind := ""
	lowerTool := strings.ToLower(toolName)
	lowerSum := strings.ToLower(summary)
	if lowerTool == "exit_plan_mode" || lowerTool == "exitplanmode" || strings.Contains(lowerSum, "exit_plan_mode") || strings.Contains(lowerSum, "exit plan mode") {
		permKind = "approve-plan"
	}
	t.approvals[id] = summary
	e := event(t, cr.EventApproval)
	e.ApprovalID = id
	e.ApprovalInfo = &cr.ApprovalInfo{
		ID:          id,
		Kind:        permKind,
		Tool:        toolName,
		Summary:     summary,
		ArgsPreview: argsPreview,
		Risk:        "high",
		Options:     opts,
	}
	w.queue(e)
}

func (w *worker) parsed(ev *util.Obj) {
	if ev == nil || w.failure != "" {
		return
	}
	typ := util.Str(ev.Get("type"))
	if typ == "session-info" {
		if title := strings.TrimSpace(util.Str(ev.Get("title"))); title != "" && w.onTitle != nil {
			w.onTitle(title)
		}
		return
	}
	if typ == "status" {
		if pm := strings.TrimSpace(util.Str(ev.Get("permissionMode"))); pm != "" && w.onMode != nil {
			if mapped := toManagedPermissionMode(cli.FromCliPermissionMode(w.backendID, pm)); mapped != "" {
				w.onMode(mapped)
			}
		}
	}
	if typ == "config-update" {
		m := strings.TrimSpace(util.Str(ev.Get("model")))
		ef := strings.TrimSpace(util.Str(ev.Get("effort")))
		if m != "" && m != "cli-default" {
			w.effectiveModel = m
		}
		if ef != "" {
			w.appliedEffort = ef
		}
		if (m != "" || ef != "") && w.onModel != nil {
			w.onModel(m, ef)
		}
		return
	}
	t := w.active
	if t == nil {
		if w.completed && typ != "" && typ != "context" && typ != "thinking" && typ != "done" && typ != "status" && typ != "session-info" && typ != "plan" && typ != "plan-removed" && typ != "config-update" && typ != "notice" && typ != "agent-state" && typ != "agent" && typ != "agent-text" && typ != "agent-text-delta" {
			w.fail("unsolicited native output after completion")
		}
		return
	}
	if t.terminal {
		return
	}
	switch typ {
	case "text", "text-delta":
		prevLen := len(t.text)
		t.text = clisdk.AppendText(t.text, ev)
		if len(t.text) > 2<<20 {
			w.fail("native assistant output exceeds limit")
			return
		}
		if len(t.text) > prevLen {
			t.pushStream(t.text[prevLen:], "", false)
		}
	case "thinking":
		if th := util.Str(ev.Get("text")); th != "" {
			t.pushStream("", th, true)
		}
	case "context":
		var tokPtr, winPtr *int64
		var costPtr *float64
		if f, ok := asNonNegFloat(ev.Get("tokens")); ok {
			v := int64(f)
			t.ctxTokens = &v
			tokPtr = &v
		}
		if f, ok := asPosFloat(ev.Get("window")); ok {
			v := int64(f)
			t.ctxWindow = &v
			winPtr = &v
		}
		if f, ok := asNonNegFloat(ev.Get("costUsd")); ok {
			v := f
			t.costUsd = &v
			costPtr = &v
		}
		if tokPtr != nil || winPtr != nil {
			ce := event(t, cr.EventContext)
			ce.ContextTokens = tokPtr
			ce.ContextWindow = winPtr
			ce.CostUsd = costPtr
			w.queue(ce)
		}
	case "status":
		stKind := strings.TrimSpace(util.Str(ev.Get("kind")))
		if stKind == "compact" || stKind == "clear" || stKind == "working" || stKind == "blocked" || stKind == "retry" || stKind == "reconnect" {
			me := event(t, cr.EventMeta)
			me.Status = &cr.RuntimeStatus{
				Kind: stKind,
				Text: strings.TrimSpace(util.Str(ev.Get("text"))),
			}
			w.queue(me)
		}
	case "notice":
		if txt := strings.TrimSpace(util.Str(ev.Get("text"))); txt != "" {
			tag := strings.TrimSpace(util.Str(ev.Get("tag")))
			if tag == "" {
				tag = "info"
			}
			me := event(t, cr.EventMeta)
			me.Notice = &cr.RuntimeNotice{
				Tag:  tag,
				Text: txt,
				At:   time.Now().UnixMilli(),
			}
			w.queue(me)
		}
	case "session-info", "agent-state", "agent-text", "agent-text-delta":
	case "plan":
		t.clearThinking()
		planID := strings.TrimSpace(util.Str(ev.Get("planId")))
		id := "plan:default"
		if planID != "" {
			id = "plan:" + planID
		}
		payload := util.NewObj()
		if entries := ev.Get("entries"); entries != nil {
			payload.Set("entries", entries)
		} else {
			payload.Set("entries", []any{})
		}
		if planID != "" {
			payload.Set("planId", planID)
		}
		if md := strings.TrimSpace(util.Str(ev.Get("markdown"))); md != "" {
			payload.Set("markdown", md)
		}
		if uri := strings.TrimSpace(util.Str(ev.Get("uri"))); uri != "" {
			payload.Set("uri", uri)
		}
		textAt := util.UTF16Len(t.text)
		te := event(t, cr.EventTrace)
		te.Trace = &cr.TraceEntry{
			ID:     id,
			Kind:   "plan",
			Detail: util.Stringify(payload),
			At:     time.Now().UnixMilli(),
			TextAt: &textAt,
		}
		w.queue(te)
	case "plan-removed":
		planID := strings.TrimSpace(util.Str(ev.Get("planId")))
		id := "plan:default"
		if planID != "" {
			id = "plan:" + planID
		}
		te := event(t, cr.EventTrace)
		te.Trace = &cr.TraceEntry{
			ID:   id,
			Kind: "plan-removed",
			At:   time.Now().UnixMilli(),
		}
		w.queue(te)
	case "agent":
		t.clearThinking()
		aid := strings.TrimSpace(util.Str(ev.Get("id")))
		if aid != "" {
			st := strings.TrimSpace(util.Str(ev.Get("status")))
			if st == "" {
				st = "running"
			}
			summary := strings.TrimSpace(util.Str(ev.Get("label")))
			if summary == "" {
				summary = strings.TrimSpace(util.Str(ev.Get("agentType")))
			}
			detail := strings.TrimSpace(util.Str(ev.Get("summary")))
			if detail == "" {
				detail = strings.TrimSpace(util.Str(ev.Get("progress")))
			}
			textAt := util.UTF16Len(t.text)
			te := event(t, cr.EventTrace)
			te.Trace = &cr.TraceEntry{
				ID:      "agent:" + aid,
				Kind:    "agent",
				Tool:    "subagent",
				Summary: summary,
				Status:  st,
				Detail:  detail,
				At:      time.Now().UnixMilli(),
				TextAt:  &textAt,
			}
			w.queue(te)
		}
	case "tool":
		t.clearThinking()
		id := util.Str(ev.Get("detail"))
		name := util.Str(ev.Get("name"))
		status := util.Str(ev.Get("status"))
		if id == "" {
			id = name
		}
		if id != "" && name != "" {
			textAt := util.UTF16Len(t.text)
			te := event(t, cr.EventTrace)
			te.Trace = &cr.TraceEntry{
				ID:      id,
				Kind:    "tool",
				Tool:    name,
				Summary: name,
				Detail:  util.Str(ev.Get("input")),
				Output:  util.Str(ev.Get("output")),
				Status:  status,
				At:      time.Now().UnixMilli(),
				TextAt:  &textAt,
			}
			w.queue(te)
		}
	case "done":
		t.clearThinking()
		t.terminal = true
		if t.text == "" {
			t.text = util.Str(ev.Get("text"))
		}
	case "error":
		w.fail("native error or unsupported background capability")
	}
}

func (w *worker) queue(e cr.Event) {
	t := w.active
	if t == nil {
		return
	}
	select {
	case t.events <- e:
	default:
		w.fail("native event queue exceeds limit")
	}
}

func (w *worker) kill() {
	if w.child.ExitCode() == nil && (w.driver == nil || !w.driver.Closed()) {
		killGroup(w.child.Pid)
	}
	if w.driver != nil {
		w.driver.Close()
	}
}

func (w *worker) fail(detail string) {
	if w.failure == "" {
		w.failure = detail
		if w.completed && w.active == nil && w.last != nil && w.notify != nil {
			previous, notify := w.last, w.notify
			go func() {
				<-previous.finished
				e := event(previous, cr.EventActivity)
				e.Work = cr.Activity{Background: 1}
				_ = notify(e)
			}()
		}
	}
	w.completed = false
	w.kill()
}
