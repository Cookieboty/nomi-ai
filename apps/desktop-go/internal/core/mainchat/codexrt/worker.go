package codexrt

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/google/uuid"
)

type worker struct {
	last                 *turn
	notify               func(cr.Event) error
	onTitle              func(string)
	child                *nodeproc.Child
	driver               *drivers.AppServerDriver
	sid, stderr, failure string
	permissionMode       string
	closed               chan struct{}
	closeOnce            sync.Once
	active               *turn
	completed, stopped   bool
	// methods records JSON-RPC methods the driver sent during recovery; ACK
	// evidence requires only initialize plus exactly one thread frame.
	methods map[string]bool
}

// officialArgs assembles the official app-server argv matching the selected permission policy.
// The subcommand "app-server" is always last.
func officialArgs(cfg Config) []string {
	permMode := effectivePermissionMode(cfg.PermissionMode)
	cliMode := toCliPermissionMode(permMode)
	prefix := []string{"-c", "analytics.enabled=false"}
	if permMode == "deny" {
		prefix = []string{"-s", "read-only", "-a", "never", "-c", "analytics.enabled=false"}
	}
	model := cfg.Model
	if model == "cli-default" {
		model = ""
	}
	if cfg.Source == "thirdParty" {
		args := append([]string{}, prefix...)
		if cfg.Effort != "" {
			args = append(args, "-c", `model_reasoning_effort="`+cfg.Effort+`"`)
		}
		permArgs, _ := codex.Permissions.Launch(cliMode, nil)
		args = append(args, permArgs...)
		args = append(args, cfg.ExtraArgs...)
		if model != "" && !cfg.ModelInConfig {
			args = append(args, "-c", `model="`+model+`"`)
		}
		args = append(args, "app-server")
		return args
	}
	var modelPtr *string
	if model != "" {
		modelPtr = &model
	}
	var accountDir *string
	if cfg.Source != "local" && cfg.ConfigDir != "" {
		accountDir = &cfg.ConfigDir
	}
	launch := codex.OfficialLaunch(clisdk.LaunchContext{Cwd: cfg.Cwd, PermissionMode: cliMode, Model: modelPtr, AccountDir: accountDir})
	args := append([]string{}, prefix...)
	if cfg.Effort != "" {
		args = append(args, "-c", `model_reasoning_effort="`+cfg.Effort+`"`)
	}
	args = append(args, launch.Args...)
	args = append(args, cfg.ExtraArgs...)
	args = append(args, "app-server")
	return args
}

// strippedEnv are credential/account overrides the official CLI must never
// inherit from the host environment. CODEX_HOME is re-set from OfficialLaunch.
var strippedEnv = []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME"}

// officialEnv is the child environment: host env minus stripped keys, plus
// the OfficialLaunch env (CODEX_HOME = the bound config dir).
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
		model := cfg.Model
		if model == "cli-default" {
			model = ""
		}
		var modelPtr *string
		if model != "" {
			modelPtr = &model
		}
		var accountDir *string
		if cfg.Source != "local" && cfg.ConfigDir != "" {
			accountDir = &cfg.ConfigDir
		}
		launch := codex.OfficialLaunch(clisdk.LaunchContext{Cwd: cfg.Cwd, PermissionMode: toCliPermissionMode(effectivePermissionMode(cfg.PermissionMode)), Model: modelPtr, AccountDir: accountDir})
		for _, k := range strippedEnv {
			if cfg.Source == "local" && k == "CODEX_HOME" {
				continue
			}
			drop[k] = true
		}
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

func appendCappedStderr(cur, chunk string, limit int) string {
	const suffix = "\n[truncated]"
	if len(cur) >= limit || strings.HasSuffix(cur, suffix) {
		return cur
	}
	remain := limit - len(cur)
	if len(chunk) <= remain {
		return cur + chunk
	}
	cut := remain
	for cut > 0 && !utf8.ValidString(chunk[:cut]) {
		cut--
	}
	return cur + chunk[:cut] + suffix
}

func (r *Runtime) spawn() *worker {
	cfg := r.config
	args := officialArgs(cfg)
	env := officialEnv(cfg)
	w := &worker{
		permissionMode: effectivePermissionMode(cfg.PermissionMode),
		closed:         make(chan struct{}),
		onTitle:        r.emitTitle,
	}
	w.child = nodeproc.Spawn(cfg.Executable, args, nodeproc.Options{Cwd: cfg.Cwd, Env: env, Detached: true})
	w.child.OnStderr(func(chunk string) {
		w.stderr = appendCappedStderr(w.stderr, chunk, 8192)
	})
	w.child.OnClose(func(*int, string) { w.closeOnce.Do(func() { close(w.closed) }) })
	bounded := newBoundedChild(w)
	w.driver = drivers.NewAppServerDriver(drivers.AppServerDriverOptions{
		Child: bounded,
		Kill:  func(clisdk.ChildLike) { killGroup(w.child.Pid) },
		NewID: func() string { return uuid.NewString() },
		MapItem: func(phase string, item drivers.Json) []drivers.Json {
			w.inspectItem(phase, item)
			if item == nil {
				return nil
			}
			itemType, _ := item.Get("type").(string)
			isAgentMsg := itemType == "agentMessage"
			if isAgentMsg && (phase != "completed" || (w.active != nil && w.active.text != "")) {
				return nil
			}
			mapped := drivers.CodexExecItem(item)
			if mapped == nil {
				return nil
			}
			typ := "item.completed"
			if phase == "started" {
				typ = "item.started"
			}
			raw, err := json.Marshal(util.NewObj("type", typ, "item", mapped))
			if err != nil {
				return nil
			}
			evs := codex.ParseLine(string(raw))
			out := make([]drivers.Json, 0, len(evs))
			for _, ev := range evs {
				if ev.Get("type") == "done" {
					continue
				}
				out = append(out, ev)
			}
			return out
		},
	})
	w.driver.On(func(ev clisdk.SessionEvent) {
		if ev == nil {
			return
		}
		kind, _ := ev.Get("kind").(string)
		switch kind {
		case "harness":
			w.parsed(util.AsObj(ev.Get("event")))
		case "request":
			// Every JSON-RPC request id observed; recovery ACK requires that the
			// only frames sent were initialize followed by exactly one
			// thread/resume or thread/start.
			if m, _ := ev.Get("method").(string); m != "" && w.methods != nil {
				w.methods[m] = true
			}
		case "permission":
			if w.permissionMode == "deny" {
				w.fail("unsupported native approval/question; never auto-approved")
				return
			}
			w.onPermission(ev)
		case "question":
			w.fail("unsupported native approval/question; never auto-approved")
		}
	})
	return w
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

func codexApprovalToolName(method, summary string) string {
	switch method {
	case "item/commandExecution/requestApproval":
		return "bash"
	case "item/fileChange/requestApproval":
		return "apply_patch"
	default:
		if strings.TrimSpace(summary) != "" {
			return summary
		}
		return "codex"
	}
}

func (w *worker) onPermission(se clisdk.SessionEvent) {
	t := w.active
	if t == nil || !t.started {
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
	method := util.Str(req.Get("method"))
	if summary == "" {
		summary = "tool action"
	}
	toolName := codexApprovalToolName(method, summary)
	t.approvals[id] = req
	e := event(t, cr.EventApproval)
	e.ApprovalID = id
	e.ApprovalInfo = &cr.ApprovalInfo{
		ID:      id,
		Tool:    toolName,
		Summary: summary,
		Danger:  "destructive",
		Risk:    "high",
	}
	w.queue(e)
}

func (w *worker) kill() {
	// Never signal a known-exited/reaped PID: its process-group number may
	// have been reused. Remaining descendants are conservatively unconfirmed.
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
			// Order after the completed transition, with its OLD generation
			// token. A switch/cancel has already fenced it; otherwise observed
			// uncertainty must make even a completed conversation non-idle.
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

// inspectItem maps v2 ThreadItem types onto the official codex.ParseLine
// vocabulary and fails closed on tools that would need user approval.
func (w *worker) inspectItem(phase string, item drivers.Json) {
	if item == nil || w.failure != "" || w.active == nil {
		return
	}
	typ, _ := item.Get("type").(string)
	switch typ {
	case "userMessage":
		if phase == "completed" {
			if text, ok := item.Get("text").(string); ok && text == w.active.request.Plan.Payload {
				w.active.echoed = true
			}
		}
	case "collabAgentToolCall", "subAgentActivity", "subagent":
		w.fail("unsupported native subagent/collab tool")
	case "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch":
		if w.permissionMode == "deny" {
			w.fail("unsupported native tool; never auto-approved")
		}
	}
}

func (w *worker) parsed(ev *util.Obj) {
	if ev == nil || w.failure != "" {
		return
	}
	if util.Str(ev.Get("type")) == "session-info" {
		if title := strings.TrimSpace(util.Str(ev.Get("title"))); title != "" && w.onTitle != nil {
			w.onTitle(title)
		}
		return
	}
	t := w.active
	if t == nil || !t.started {
		// Idle-only select: events outside an active turn (late output after
		// cancel/switch/resolve) never mutate authority and never replay text.
		// During startup however, an explicit server error or a protocol-level
		// malformed line is a real failure and must not look like a timeout.
		if typ := util.Str(ev.Get("type")); typ == "error" || typ == "protocol-error" {
			w.fail("native server error before user input")
		}
		return
	}
	typ := util.Str(ev.Get("type"))
	if t.terminal {
		return
	}
	switch typ {
	case "error":
		msg := strings.TrimSpace(util.Str(ev.Get("message")))
		if msg == "" {
			msg = "native error event"
		}
		w.fail(msg)
		return
	case "question", "agent":
		w.fail("native error or unsupported interactive/background capability")
		return
	case "permission":
		t.unsupported = true
		w.fail("unsupported native approval/tool; never auto-approved")
		return
	case "tool":
		if w.permissionMode == "deny" {
			t.unsupported = true
			w.fail("unsupported native approval/tool; never auto-approved")
			return
		}
		t.clearThinking()
		name := util.Str(ev.Get("name"))
		id := util.Str(ev.Get("id"))
		if id == "" {
			id = util.Str(ev.Get("detail"))
		}
		if id == "" {
			id = name
		}
		if id != "" && name != "" {
			detail := util.Str(ev.Get("input"))
			if detail == "" {
				detail = util.Str(ev.Get("detail"))
			}
			te := event(t, cr.EventTrace)
			te.Trace = &cr.TraceEntry{
				ID:      id,
				Kind:    "tool",
				Tool:    name,
				Summary: name,
				Detail:  detail,
				Output:  util.Str(ev.Get("output")),
				Status:  util.Str(ev.Get("status")),
				At:      time.Now().UnixMilli(),
			}
			w.queue(te)
		}
	case "done":
		t.clearThinking()
		t.terminal = true
		if t.text == "" {
			t.text = util.Str(ev.Get("text"))
		}
		if u := util.AsObj(ev.Get("usage")); u != nil {
			t.usage = buildTurnUsage(u, t.ctxTokens, t.ctxWindow, t.costUsd, 0)
			if m := util.Str(u.Get("model")); m != "" && m != "cli-default" {
				t.model = m
			}
			if rm := util.Str(u.Get("responseModel")); rm != "" {
				t.responseModel = rm
			}
		}
		if m := util.Str(ev.Get("model")); m != "" && m != "cli-default" {
			t.model = m
		}
		if rm := util.Str(ev.Get("responseModel")); rm != "" {
			t.responseModel = rm
		}
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
		if f, ok := asNonNegFloat(ev.Get("tokens")); ok {
			v := int64(f)
			t.ctxTokens = &v
		}
		if f, ok := asPosFloat(ev.Get("window")); ok {
			v := int64(f)
			t.ctxWindow = &v
		}
		if f, ok := asNonNegFloat(ev.Get("costUsd")); ok {
			v := f
			t.costUsd = &v
		}
		if m := util.Str(ev.Get("model")); m != "" && m != "cli-default" {
			t.model = m
		}
	}
}

// boundedChild bounds raw output BEFORE the shared driver's splitter, decodes
// UTF-8 incrementally, and fails closed when startup answered with a JSON-RPC
// rejection (which the official transport would only see as a timeout). The
// wedged transport is never released: its queued requests must not reach the
// server. Pass-through never deadlocks (no uint8/string callbacks are
// registered on the raw child; only byte callbacks are).
type boundedChild struct {
	clisdk.ChildLike
	raw      *nodeproc.Child
	out      []byte
	outTotal int
	failed   bool
	w        *worker
}

func newBoundedChild(w *worker) *boundedChild {
	b := &boundedChild{ChildLike: clisdk.ProcChild{Child: w.child}, raw: w.child, w: w}
	w.child.OnClose(func(*int, string) {
		if len(b.out) > 0 && !b.failed {
			b.failed = true
			w.fail("truncated native UTF-8 at EOF")
		}
	})
	return b
}

func (b *boundedChild) OnStdout(fn func(string)) {
	b.raw.OnStdoutBytes(func(chunk []byte) {
		if b.failed {
			return
		}
		w := b.w
		if b.out == nil {
			// Steady state: one pass-through per chunk, no extra copying.
			fn(string(chunk))
			return
		}
		// Buffered startup tail/remainder: re-examine complete lines only.
		b.out = append(b.out, chunk...)
		b.outTotal += len(chunk)
		if b.outTotal > 8<<20 {
			b.failed = true
			w.fail("native startup output exceeds limit")
			return
		}
		if completePrefix(b.out) < len(b.out) && !utf8.Valid(b.out) {
			// Let a split trailing rune arrive with the next chunk.
			if !utf8.Valid(b.out[:completePrefix(b.out)]) {
				b.failed = true
				w.fail("invalid native UTF-8")
			}
		}
		for {
			i := bytes.IndexByte(b.out, '\n')
			if i < 0 {
				break
			}
			line := string(b.out[:i])
			b.out = b.out[i+1:]
			if w.failure != "" {
				return
			}
			if b.startupLine(line, w) {
				// Leaving startup: replay buffered frames (driver splitter
				// handles partial lines) and pass through from now on.
				out := append([]byte(line), '\n')
				out = append(out, b.out...)
				b.out = nil
				b.outTotal = 0
				fn(string(out))
				return
			}
			if trimmed := strings.TrimSpace(line); trimmed == "" || !strings.HasPrefix(trimmed, "{") {
				// Log/stub line: nothing left to validate, so stop buffering.
				b.out = b.out[i+1:]
				out := append([]byte(line), '\n')
				out = append(out, b.out...)
				b.out = nil
				b.outTotal = 0
				fn(string(out))
				return
			}
		}
		if len(b.out) == 0 {
			b.outTotal = 0
		}
	})
}

// completePrefix returns the length of the longest prefix that ends on a rune
// boundary (a trailing incomplete UTF-8 sequence is allowed to grow).
func completePrefix(data []byte) int {
	end := 0
	for end < len(data) {
		if !utf8.FullRune(data[end:]) {
			break
		}
		_, n := utf8.DecodeRune(data[end:])
		end += n
	}
	return end
}

// startupLine validates one complete startup frame. Returns true when it is the
// first thread request frame (thread/resume or thread/start).
func (b *boundedChild) startupLine(line string, w *worker) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	if strings.Contains(trimmed, `"method":"thread/resume"`) || strings.Contains(trimmed, `"method":"thread/start"`) {
		return true
	}
	var msg struct {
		ID     any    `json:"id"`
		Method string `json:"method"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if !strings.HasPrefix(trimmed, "{") || json.Unmarshal([]byte(trimmed), &msg) != nil {
		b.failed = true
		w.fail("malformed native startup output")
		return false
	}
	if msg.Error != nil && msg.ID == nil && msg.Method != "" {
		b.failed = true
		w.fail("native server rejected a startup frame: " + util.Str(msg.Error.Message))
	}
	return false
}
