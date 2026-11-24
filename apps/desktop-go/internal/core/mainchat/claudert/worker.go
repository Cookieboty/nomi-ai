package claudert

import (
	"encoding/json"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/google/uuid"
)

type worker struct {
	last                          *turn
	notify                        func(cr.Event) error
	onTitle                       func(string)
	child                         *nodeproc.Child
	driver                        *drivers.StreamJsonDriver
	sid, lastID, stderr, failure  string
	permissionMode                string
	expectedNativeMode            string
	closed                        chan struct{}
	active                        *turn
	confirmed, completed, stopped bool
}

func (r *Runtime) spawn(sid string, resume bool) *worker {
	cfg := r.config
	permMode := effectivePermissionMode(cfg.PermissionMode)
	cliMode := toCliPermissionMode(permMode)
	nativeMode := effectiveNativeMode(permMode, cfg.Source)
	model := cfg.Model
	if model == "cli-default" {
		model = ""
	}
	var modelPtr *string
	if model != "" {
		modelPtr = &model
	}
	// --bare would DISABLE subscription login, so it must NOT be used here.
	// These documented flags preserve official login while removing discovery
	// and binding MCP / hooks strictly to product policy.
	mcpCfgRaw := `{"mcpServers":{}}`
	hasComputerMcp := cfg.ComputerMcp != nil && cfg.ComputerMcp.Name != "" && cfg.ComputerMcp.Command != ""
	if hasComputerMcp {
		mcpCfg, _ := json.Marshal(map[string]any{
			"mcpServers": map[string]any{
				cfg.ComputerMcp.Name: map[string]any{"type": "stdio", "command": cfg.ComputerMcp.Command, "args": cfg.ComputerMcp.Args},
			},
		})
		mcpCfgRaw = string(mcpCfg)
	}
	args := []string{"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--replay-user-messages", "--disable-slash-commands", "--setting-sources", "", "--settings", `{"disableAllHooks":true}`}
	if permMode == "deny" {
		args = append(args, "--tools", "Read,Glob,Grep")
	}
	args = append(args, "--strict-mcp-config", "--mcp-config", mcpCfgRaw)
	if hasComputerMcp {
		args = append(args, "--allowedTools", "mcp__"+cfg.ComputerMcp.Name)
	} else {
		args = append(args, "--disallowedTools", "mcp__*")
	}
	stripped := map[string]bool{}
	for _, k := range cfg.StripEnv {
		stripped[k] = true
	}
	for k := range cfg.ExtraEnv {
		stripped[k] = true
	}
	var launchEnv *util.Obj
	if cfg.Source == "thirdParty" {
		args = append(args, "--permission-mode", nativeMode)
		args = append(args, cfg.ExtraArgs...)
		if model != "" && !cfg.ModelInConfig {
			args = append(args, "--model", model)
		}
	} else {
		var accountDir *string
		if cfg.Source != "local" && cfg.ConfigDir != "" {
			accountDir = &cfg.ConfigDir
		}
		launch := claude.OfficialLaunch(clisdk.LaunchContext{Cwd: cfg.Cwd, PermissionMode: cliMode, Model: modelPtr, AccountDir: accountDir})
		if cfg.Effort != "" {
			args = append(args, "--effort", cfg.Effort)
		}
		args = append(args, launch.Args...)
		args = append(args, cfg.ExtraArgs...)
		for _, k := range launch.Strip {
			stripped[k] = true
		}
		if launch.Env != nil {
			for _, k := range launch.Env.Keys() {
				stripped[k] = true
			}
			launchEnv = launch.Env
		}
	}
	if resume {
		args = append(args, "--resume", sid)
	} else {
		args = append(args, "--session-id", sid)
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !stripped[key] {
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
	w := &worker{sid: sid, permissionMode: permMode, expectedNativeMode: nativeMode, closed: make(chan struct{}), onTitle: r.emitTitle}
	w.child = nodeproc.Spawn(cfg.Executable, args, nodeproc.Options{Cwd: cfg.Cwd, Env: env, Detached: true})
	w.child.OnStderr(func(chunk string) {
		w.stderr = appendCappedStderr(w.stderr, chunk, 8192)
	})
	w.child.OnClose(func(*int, string) { close(w.closed) })
	parse := claude.NewParser()
	bounded := &boundedChild{ChildLike: clisdk.ProcChild{Child: w.child}, raw: w.child, fail: w.fail}
	w.driver = drivers.NewStreamJsonDriver(drivers.StreamJsonDriverOptions{Child: bounded, ParseLine: parse, OnLine: w.line, NewID: func() string { w.lastID = uuid.NewString(); return w.lastID }, Kill: func(clisdk.ChildLike) { killGroup(w.child.Pid) }})
	w.driver.On(func(ev clisdk.SessionEvent) {
		if ev.Get("kind") == "harness" {
			w.parsed(util.AsObj(ev.Get("event")))
		}
	})
	return w
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
			// Order after the completed transition, with its OLD generation token.
			// A switch/cancel has already fenced it; otherwise observed background
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
func (w *worker) queue(e cr.Event) {
	select {
	case w.active.events <- e:
	default:
		w.fail("native event queue exceeds limit")
	}
}
func (w *worker) ack() {
	t := w.active
	if t == nil || t.acked || !w.confirmed || !t.echoed {
		return
	}
	t.acked = true
	e := event(t, cr.EventDelivered)
	e.Delivery = cr.Delivery{PlanID: t.request.Plan.ID, NativeSessionID: w.sid, Kind: cr.DeliveredFull}
	w.queue(e)
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

func hasNonNullJSON(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed != "" && trimmed != "null" && trimmed != "false" && trimmed != "[]" && trimmed != "{}"
}

func hasNonEmptyJSONList(items []json.RawMessage) bool {
	for _, item := range items {
		if hasNonNullJSON(item) {
			return true
		}
	}
	return false
}

// isActiveClaudeWorkEvent reports top-level Claude stream-json events that initiate
// or advance turn work/interactions (as opposed to system or passive lifecycle notices).
func isActiveClaudeWorkEvent(typ string) bool {
	switch typ {
	case "user", "assistant", "stream_event", "result", "control_request", "error":
		return true
	default:
		return false
	}
}

func extractClaudeJSONText(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	v, err := util.Parse(raw)
	if err != nil || v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case *util.Obj:
		for _, k := range []string{"message", "error", "text"} {
			if s := strings.TrimSpace(util.Str(x.Get(k))); s != "" {
				return s
			}
		}
	}
	return ""
}

func extractClaudeResultError(resultRaw json.RawMessage, errorsRaw []json.RawMessage, errRaw json.RawMessage, fallback string) string {
	var parts []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		parts = append(parts, s)
	}
	add(extractClaudeJSONText(resultRaw))
	for _, item := range errorsRaw {
		add(extractClaudeJSONText(item))
	}
	if len(parts) == 0 {
		add(extractClaudeJSONText(errRaw))
	}
	if len(parts) == 0 {
		add(fallback)
	}
	return strings.Join(parts, "; ")
}

func claudeNativeModeRank(mode string) (int, bool) {
	switch mode {
	case "plan":
		return 1, true
	case "default":
		return 2, true
	case "acceptEdits":
		return 3, true
	case "auto":
		return 4, true
	case "bypassPermissions":
		return 5, true
	default:
		return 0, false
	}
}

// isAllowedClaudeNativeMode 允许与请求相等或安全降级的模式，严格拒绝未知模式与提权。
func isAllowedClaudeNativeMode(requested, reported string) bool {
	if reported == "" {
		return true
	}
	reqRank, ok1 := claudeNativeModeRank(requested)
	repRank, ok2 := claudeNativeModeRank(reported)
	return ok1 && ok2 && repRank <= reqRank
}

func (w *worker) line(line string, _ bool) bool {
	if w.failure != "" {
		return true
	} // Ignore the rest of an already-buffered stdout chunk after failure.
	if strings.TrimSpace(line) == "" {
		return true
	}
	var j struct {
		Type, Subtype, UUID string
		PermissionMode      string            `json:"permissionMode"`
		SessionID           string            `json:"session_id"`
		IsError             bool              `json:"is_error"`
		Parent              any               `json:"parent_tool_use_id"`
		RequestID           string            `json:"request_id"`
		Request             json.RawMessage   `json:"request"`
		Message             json.RawMessage   `json:"message"`
		Result              json.RawMessage   `json:"result"`
		Errors              []json.RawMessage `json:"errors"`
		Error               json.RawMessage   `json:"error"`
	}
	if len(line) > 2<<20 || !utf8.ValidString(line) || json.Unmarshal([]byte(line), &j) != nil || j.Type == "" {
		w.fail("malformed native event")
		return true
	}
	if j.PermissionMode != "" && !isAllowedClaudeNativeMode(w.expectedNativeMode, j.PermissionMode) {
		w.fail("native effective permission mode differs from requested " + w.expectedNativeMode + ": " + j.PermissionMode)
		return true
	}
	if j.SessionID != "" && j.SessionID != w.sid {
		w.fail("native session identity changed")
		return true
	}
	if j.Parent != nil && j.Parent != "" {
		w.fail("subagent events unsupported")
		return true
	}
	if j.Type == "system" && j.Subtype == "init" {
		if j.SessionID != w.sid {
			w.fail("native init omitted identity")
			return true
		}
		w.confirmed = true
		w.ack()
	}
	if j.Type == "system" && (strings.HasPrefix(j.Subtype, "task_") || strings.HasPrefix(j.Subtype, "hook_")) {
		w.fail("background work/hooks unsupported: " + j.Subtype)
		return true
	}
	if j.Type != "control_request" && (j.RequestID != "" || hasNonNullJSON(j.Request)) {
		w.fail("unsupported native request event: " + j.Type)
		return true
	}
	isActive := isActiveClaudeWorkEvent(j.Type)
	t := w.active
	if t != nil && j.Type == "system" && j.Subtype == "api_retry" && len(j.Error) > 0 {
		if retryMsg := extractClaudeJSONText(j.Error); retryMsg != "" {
			t.lastRetryError = retryMsg
		}
	}
	if t == nil {
		if w.completed && isActive {
			w.fail("unsolicited native work after completion: " + j.Type)
			return true
		}
		if j.Type != "system" && isActive {
			w.fail("unsolicited native event before turn: " + j.Type)
			return true
		}
		return false
	}
	if j.Type == "rate_limit_event" {
		return false
	}
	if t.terminal {
		if isActive {
			w.fail("native event after terminal result: " + j.Type)
			return true
		}
		return false
	}
	switch j.Type {
	case "user":
		var msg struct {
			Content json.RawMessage `json:"content"`
		}
		var content string
		if j.UUID == t.uuid && len(j.Message) > 0 && json.Unmarshal(j.Message, &msg) == nil &&
			json.Unmarshal(msg.Content, &content) == nil && content == t.request.Plan.Payload {
			t.echoed = true
			w.ack()
		}
	case "result":
		t.terminal = true
		switch {
		case j.IsError || j.Subtype != "success":
			detail := extractClaudeResultError(j.Result, j.Errors, j.Error, t.lastRetryError)
			if detail == "" {
				if j.Subtype != "" && j.Subtype != "success" {
					detail = "native terminal result failed: " + j.Subtype
				} else {
					detail = "native terminal result returned error"
				}
			} else if j.Subtype != "" && j.Subtype != "success" && !strings.Contains(detail, j.Subtype) {
				detail = j.Subtype + ": " + detail
			}
			w.fail(detail)
			return true
		case j.SessionID != w.sid:
			w.fail("native result session identity mismatch")
			return true
		case len(t.approvals) != 0 || len(t.tools) != 0:
			w.fail("native terminal result arrived with pending approvals or tools")
			return true
		}
		w.confirmed = true
		t.success = true
	case "control_request":
		var req struct {
			Subtype string          `json:"subtype"`
			Tool    string          `json:"tool_name"`
			Input   json.RawMessage `json:"input"`
		}
		if len(j.Request) == 0 || json.Unmarshal(j.Request, &req) != nil ||
			req.Subtype != "can_use_tool" || req.Tool == "" || j.RequestID == "" ||
			(w.permissionMode == "deny" && !readTool(req.Tool)) {
			w.fail("unsupported native approval/tool")
			return true
		}
		if _, exists := t.approvals[j.RequestID]; exists {
			w.fail("duplicate native approval")
			return true
		}
		v, err := util.Parse(req.Input)
		input, ok := v.(*util.Obj)
		if err != nil || !ok {
			w.fail("invalid native approval input")
			return true
		}
		t.approvals[j.RequestID] = input
		if t.approvalTools != nil {
			t.approvalTools[j.RequestID] = req.Tool
		}
	case "assistant", "stream_event", "system", "error":
	default:
		if j.IsError || hasNonNullJSON(j.Error) || hasNonEmptyJSONList(j.Errors) {
			w.fail(extractClaudeResultError(nil, j.Errors, j.Error, "native error event: "+j.Type))
			return true
		}
		return false
	}
	return false
}
func readTool(name string) bool { return name == "Read" || name == "Glob" || name == "Grep" }
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
	t := w.active
	if t == nil {
		return
	}
	switch typ {
	case "done":
		t.clearThinking()
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
	case "permission":
		id := util.Str(ev.Get("id"))
		rawInput, ok := t.approvals[id]
		if !ok {
			w.fail("permission lacks original native input")
			return
		}
		toolName := t.approvalTools[id]
		preview := util.Stringify(rawInput)
		if len(preview) > 600 {
			preview = preview[:600]
		}
		danger := "destructive"
		if readTool(toolName) {
			danger = "read"
		}
		e := event(t, cr.EventApproval)
		e.ApprovalID = id
		e.ApprovalInfo = &cr.ApprovalInfo{
			ID:          id,
			Tool:        toolName,
			Summary:     toolName,
			ArgsPreview: preview,
			Danger:      danger,
		}
		w.queue(e)
	case "tool":
		t.clearThinking()
		id := util.Str(ev.Get("detail"))
		name := util.Str(ev.Get("name"))
		status := util.Str(ev.Get("status"))
		if status == "start" {
			if name == "" || id == "" || (w.permissionMode == "deny" && !readTool(name)) {
				w.fail("unsupported native tool started")
				return
			}
			t.tools[id] = true
		} else {
			delete(t.tools, id)
		}
		if id != "" && name != "" {
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
			}
			w.queue(te)
		}
	case "error":
		msg := strings.TrimSpace(util.Str(ev.Get("message")))
		if msg == "" {
			msg = "native error event"
		}
		w.fail(msg)
	case "question", "agent":
		w.fail("unsupported interactive/background capability: " + typ)
	}
}

// Bound raw lines BEFORE the shared driver's splitter, and decode UTF-8
// incrementally. nodeproc's string callbacks intentionally replace split runes
// per chunk (legacy Buffer.toString semantics), which is NOT lossless here.
type boundedChild struct {
	clisdk.ChildLike
	raw     *nodeproc.Child
	partial int
	pending []byte
	failed  bool
	fail    func(string)
}

func (b *boundedChild) OnStdout(fn func(string)) {
	b.raw.OnStdoutBytes(func(chunk []byte) {
		if b.failed {
			return
		}
		for _, c := range chunk {
			b.partial++
			if b.partial > 2<<20 {
				b.failed = true
				b.fail("native output line exceeds limit")
				return
			}
			if c == '\n' {
				b.partial = 0
			}
		}
		data := append(b.pending, chunk...)
		b.pending = nil
		end := 0
		for end < len(data) {
			if !utf8.FullRune(data[end:]) {
				b.pending = append([]byte(nil), data[end:]...)
				break
			}
			r, n := utf8.DecodeRune(data[end:])
			if r == utf8.RuneError && n == 1 {
				b.failed = true
				b.fail("invalid native UTF-8")
				return
			}
			end += n
		}
		if end > 0 {
			fn(string(data[:end]))
		}
	})
	b.raw.OnClose(func(*int, string) {
		if len(b.pending) > 0 && !b.failed {
			b.failed = true
			b.fail("truncated native UTF-8 at EOF")
		}
	})
}
