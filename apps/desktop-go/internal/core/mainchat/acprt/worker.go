package acprt

import (
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
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
	child                *nodeproc.Child
	driver               *drivers.AcpDriver
	sid, stderr, failure string
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
	if builtin.WithAccounts(cfg.BackendID) && cfg.ConfigDir != "" {
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
		PermissionMode: "manual",
		Model:          modelPtr,
		AccountDir:     accountDir,
	})
}

func officialArgs(cfg Config) []string {
	return append([]string{}, builtin.AcpArgs(cfg.BackendID)...)
}

func officialEnv(cfg Config) []string {
	launch := officialLaunchFor(cfg)
	drop := map[string]bool{}
	for _, k := range launch.Strip {
		drop[k] = true
	}
	if launch.Env != nil {
		for _, k := range launch.Env.Keys() {
			drop[k] = true
		}
	}
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !drop[key] {
			env = append(env, entry)
		}
	}
	if launch.Env != nil {
		for _, k := range launch.Env.Keys() {
			env = append(env, k+"="+util.Str(launch.Env.Get(k)))
		}
	}
	return env
}

func (r *Runtime) spawn() *worker {
	cfg := r.config
	args := officialArgs(cfg)
	env := officialEnv(cfg)
	w := &worker{closed: make(chan struct{})}
	w.child = nodeproc.Spawn(cfg.Executable, args, nodeproc.Options{Cwd: cfg.Cwd, Env: env, Detached: true})
	w.child.OnStderr(func(chunk string) {
		if len(w.stderr)+len(chunk) > 8192 {
			w.stderr = "[truncated]"
			return
		}
		w.stderr += chunk
	})
	w.child.OnClose(func(*int, string) { w.closeOnce.Do(func() { close(w.closed) }) })
	w.driver = drivers.NewAcpDriver(drivers.AcpDriverOptions{
		Child:              clisdk.ProcChild{Child: w.child},
		Kill:               func(clisdk.ChildLike) { killGroup(w.child.Pid) },
		NewID:              func() string { return uuid.NewString() },
		DisableElicitation: true,
	})
	w.driver.On(func(ev clisdk.SessionEvent) {
		if ev == nil || w.failure != "" {
			return
		}
		kind, _ := ev.Get("kind").(string)
		switch kind {
		case "harness":
			w.parsed(util.AsObj(ev.Get("event")))
		case "permission":
			w.onPermission(ev)
		case "question":
			qid := util.Str(ev.Get("id"))
			if qid != "" && w.driver != nil {
				w.driver.RespondQuestion(qid, nil, true)
			}
			w.fail("unsupported native question/elicitation")
		}
	})
	return w
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
	toolID := util.Str(req.Get("toolUseId"))
	if summary == "" {
		summary = "tool action"
	}
	toolName := summary
	if toolID != "" {
		toolName = summary
	}
	t.approvals[id] = summary
	e := event(t, cr.EventApproval)
	e.ApprovalID = id
	e.ApprovalInfo = &cr.ApprovalInfo{
		ID:      id,
		Tool:    toolName,
		Summary: summary,
		Risk:    "high",
	}
	w.queue(e)
}

func (w *worker) parsed(ev *util.Obj) {
	if ev == nil || w.failure != "" {
		return
	}
	t := w.active
	typ := util.Str(ev.Get("type"))
	if t == nil {
		if w.completed && typ != "" && typ != "context" && typ != "thinking" && typ != "done" {
			w.fail("unsolicited native output after completion")
		}
		return
	}
	if t.terminal {
		return
	}
	switch typ {
	case "text", "text-delta":
		t.text = clisdk.AppendText(t.text, ev)
		if len(t.text) > 2<<20 {
			w.fail("native assistant output exceeds limit")
		}
	case "tool":
		id := util.Str(ev.Get("detail"))
		name := util.Str(ev.Get("name"))
		status := util.Str(ev.Get("status"))
		if id == "" {
			id = name
		}
		if id != "" && name != "" {
			te := event(t, cr.EventTrace)
			te.Trace = &cr.TraceEntry{
				ID:      id,
				Kind:    "tool",
				Tool:    name,
				Summary: name,
				Detail:  util.Str(ev.Get("input")),
				Status:  status,
				At:      time.Now().UnixMilli(),
			}
			w.queue(te)
		}
	case "done":
		t.terminal = true
		if t.text == "" {
			t.text = util.Str(ev.Get("text"))
		}
	case "error", "agent":
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
