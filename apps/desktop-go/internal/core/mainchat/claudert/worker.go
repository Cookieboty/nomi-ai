package claudert

import (
	"encoding/json"
	"os"
	"strings"
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
	child                         *nodeproc.Child
	driver                        *drivers.StreamJsonDriver
	sid, lastID, stderr, failure  string
	closed                        chan struct{}
	active                        *turn
	confirmed, completed, stopped bool
}

func (r *Runtime) spawn(sid string, resume bool) *worker {
	cfg := r.config
	model := cfg.Model
	var modelPtr *string
	if model != "" {
		modelPtr = &model
	}
	launch := claude.OfficialLaunch(clisdk.LaunchContext{Cwd: cfg.Cwd, PermissionMode: "manual", Model: modelPtr, AccountDir: &cfg.ConfigDir})
	// --bare would DISABLE subscription login, so it must NOT be used here.
	// These documented flags preserve official login while removing discovery
	// and limiting the native loop. No allowedTools/bypass permissions are added.
	args := []string{"-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--replay-user-messages", "--safe-mode", "--restricted", "--disable-slash-commands", "--setting-sources", "", "--settings", `{"disableAllHooks":true}`, "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--disallowedTools", "mcp__*"}
	args = append(args, launch.Args...)
	if resume {
		args = append(args, "--resume", sid)
	} else {
		args = append(args, "--session-id", sid)
	}
	stripped := map[string]bool{}
	for _, k := range launch.Strip {
		stripped[k] = true
	}
	for _, k := range launch.Env.Keys() {
		stripped[k] = true
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !stripped[key] {
			env = append(env, entry)
		}
	}
	for _, k := range launch.Env.Keys() {
		env = append(env, k+"="+util.Str(launch.Env.Get(k)))
	}
	w := &worker{sid: sid, closed: make(chan struct{})}
	w.child = nodeproc.Spawn(cfg.Executable, args, nodeproc.Options{Cwd: cfg.Cwd, Env: env, Detached: true})
	w.child.OnStderr(func(chunk string) {
		if len(w.stderr)+len(chunk) > 8192 {
			w.stderr = "[truncated]"
			return
		}
		w.stderr += chunk
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
func (w *worker) line(line string, _ bool) bool {
	if w.failure != "" {
		return true
	} // Ignore the rest of an already-buffered stdout chunk after failure.
	if strings.TrimSpace(line) == "" {
		return true
	}
	var j struct {
		Type, Subtype, UUID string
		PermissionMode      string `json:"permissionMode"`
		SessionID           string `json:"session_id"`
		IsError             bool   `json:"is_error"`
		Parent              any    `json:"parent_tool_use_id"`
		RequestID           string `json:"request_id"`
		Request             struct {
			Subtype string
			Tool    string `json:"tool_name"`
			Input   json.RawMessage
		}
		Message struct{ Content json.RawMessage }
	}
	if len(line) > 2<<20 || !utf8.ValidString(line) || json.Unmarshal([]byte(line), &j) != nil || j.Type == "" {
		w.fail("malformed native event")
		return true
	}
	if j.PermissionMode != "" && j.PermissionMode != "default" {
		w.fail("native effective permission mode differs from requested default")
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
		w.fail("background work/hooks unsupported")
		return true
	}
	t := w.active
	if t == nil {
		if w.completed && j.Type != "rate_limit_event" {
			w.fail("unsolicited native work after completion")
			return true
		}
		if j.Type != "system" && j.Type != "rate_limit_event" {
			w.fail("unsolicited native event before turn")
			return true
		}
		return false
	}
	if j.Type == "rate_limit_event" {
		return false
	}
	if t.terminal {
		w.fail("native event after terminal result")
		return true
	}
	switch j.Type {
	case "user":
		var content string
		if j.UUID == t.uuid && json.Unmarshal(j.Message.Content, &content) == nil && content == t.request.Plan.Payload {
			t.echoed = true
			w.ack()
		}
	case "result":
		t.terminal = true
		if j.Subtype != "success" || j.IsError || j.SessionID != w.sid || len(t.approvals) != 0 || len(t.tools) != 0 {
			w.fail("native terminal result is not a quiescent success")
			return true
		}
		w.confirmed = true
		t.success = true
	case "control_request":
		if j.Request.Subtype != "can_use_tool" || !readTool(j.Request.Tool) || j.RequestID == "" {
			w.fail("unsupported native approval/tool")
			return true
		}
		if _, exists := t.approvals[j.RequestID]; exists {
			w.fail("duplicate native approval")
			return true
		}
		v, err := util.Parse(j.Request.Input)
		input, ok := v.(*util.Obj)
		if err != nil || !ok {
			w.fail("invalid native approval input")
			return true
		}
		t.approvals[j.RequestID] = input
	case "assistant", "stream_event", "system", "rate_limit_event", "error":
	default:
		w.fail("unknown native protocol event")
		return true
	}
	return false
}
func readTool(name string) bool { return name == "Read" || name == "Glob" || name == "Grep" }
func (w *worker) parsed(ev *util.Obj) {
	t := w.active
	if t == nil || w.failure != "" {
		return
	}
	typ := util.Str(ev.Get("type"))
	switch typ {
	case "done":
		if t.text == "" {
			t.text = util.Str(ev.Get("text"))
		}
	case "text", "text-delta":
		t.text = clisdk.AppendText(t.text, ev)
		if len(t.text) > 2<<20 {
			w.fail("native assistant output exceeds limit")
		}
	case "permission":
		id := util.Str(ev.Get("id"))
		if _, ok := t.approvals[id]; !ok {
			w.fail("permission lacks original native input")
			return
		}
		e := event(t, cr.EventApproval)
		e.ApprovalID = id
		w.queue(e)
	case "tool":
		id := util.Str(ev.Get("detail"))
		if ev.Get("status") == "start" {
			if !readTool(util.Str(ev.Get("name"))) || id == "" {
				w.fail("unsupported native tool started")
				return
			}
			t.tools[id] = true
		} else {
			delete(t.tools, id)
		}
	case "error", "question", "agent":
		w.fail("native error or unsupported interactive/background capability")
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
