// Package drivers mirrors apps/desktop-electron/internal/cli-sdk/src/drivers。
package drivers

import (
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type (
	Ev           = clisdk.Ev
	SessionEvent = clisdk.SessionEvent
	TurnInput    = clisdk.TurnInput
	TurnResult   = clisdk.TurnResult
	StartResult  = clisdk.StartResult
)

var O = clisdk.O

// NewID 默认 id 生成（randomUUID）；测试可替换。
var NewID = func() string { return clisdk.RandomUUID() }

func pick(f func() string) func() string {
	if f != nil {
		return f
	}
	return NewID
}

func strOr(p *string, d string) string {
	if p != nil {
		return *p
	}
	return d
}

func sp(s string) *string { return &s }

// ExecDriverOptions mirrors ExecDriverOptions。
type ExecDriverOptions struct {
	Spawn          clisdk.SpawnFn
	Command        string
	Cwd            string
	Args           func(input TurnInput, sessionID *string) []string
	Parser         func() func(line string) []Ev
	Stdin          func(input TurnInput) *string
	ResumeID       *string
	Kill           clisdk.KillFn
	NewID          func() string
	ExitMessage    func(code *int) string
	Completes      func(ev Ev) bool
	SilentExit     func() *string
	KeepStdin      bool
	StopRequested  func() bool
	AbortedMessage *string
	OnStderr       func(chunk string)
}

// ExecDriver mirrors ExecDriver。
type ExecDriver struct {
	o       ExecDriverOptions
	hub     *clisdk.EventHub
	child   clisdk.ChildLike
	sid     *string
	ended   bool
	stopped bool
}

func NewExecDriver(o ExecDriverOptions) *ExecDriver {
	return &ExecDriver{o: o, hub: clisdk.NewEventHub(), sid: o.ResumeID}
}

func (d *ExecDriver) Events() *clisdk.Iter                     { return d.hub.Iterate() }
func (d *ExecDriver) On(fn func(SessionEvent)) func()          { return d.hub.On(fn) }
func (d *ExecDriver) SessionID() *string                       { return d.sid }
func (d *ExecDriver) Closed() bool                             { return d.ended }
func (d *ExecDriver) InTurn() bool                             { return d.child != nil }
func (d *ExecDriver) RespondPermission(string, *util.Obj) bool { return false }

func (d *ExecDriver) Start(clisdk.StartOptions) *jsrt.Promise[StartResult] {
	return jsrt.Resolved(O("sessionId", nullable(d.sid), "capabilities", O("loadSession", true)))
}

func nullable(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func (d *ExecDriver) Send(input TurnInput) *jsrt.Promise[TurnResult] {
	if d.ended {
		return jsrt.Rejected[TurnResult](errors.New("driver closed"))
	}
	if d.child != nil {
		return jsrt.Rejected[TurnResult](errors.New("previous turn still running"))
	}
	turnID := pick(d.o.NewID)()
	parse := d.o.Parser()
	child := d.o.Spawn(d.o.Command, d.o.Args(input, d.sid), d.o.Cwd)
	d.child = child
	d.stopped = false
	offAbort := input.Signal.OnAbort(func() { d.Interrupt() })
	p := jsrt.NewPromise[TurnResult]()
	lines := &clisdk.LineSplitter{}
	text := ""
	var lastError *string
	var usage any
	settled, completed := false, false
	count := 0
	strict := d.o.Completes != nil
	handle := func(line string, tail bool) {
		if clisdk.JSTrim(line) == "" {
			return
		}
		for _, ev := range parse(line) {
			count++
			text = clisdk.AppendText(text, ev)
			if ev.Get("type") == "error" {
				if m, ok := ev.Get("message").(string); ok {
					lastError = &m
				} else {
					lastError = nil
				}
			}
			if d.o.Completes != nil && d.o.Completes(ev) {
				completed = true
			}
			if ev.Get("type") == "done" {
				if s := util.Str(ev.Get("sessionId")); s != "" {
					d.sid = &s
				}
				if util.Truthy(ev.Get("usage")) {
					usage = ev.Get("usage")
				}
				if text == "" && util.Truthy(ev.Get("text")) {
					text = util.Str(ev.Get("text"))
				}
				if d.o.KeepStdin {
					func() { defer func() { _ = recover() }(); child.Stdin().End() }()
				}
			}
			if ev.Get("type") == "permission" {
				d.hub.Emit(clisdk.WithOpt(O("kind", "permission"), "id", ev.Get("id"), "request", clisdk.WithOpt(O(), "summary", ev.Get("summary")), "turnId", turnID))
			}
			e := O("kind", "harness", "event", ev, "turnId", turnID)
			if tail {
				e.Set("tail", true)
			}
			d.hub.Emit(e)
		}
	}
	child.OnStdout(func(c string) {
		for _, line := range lines.Push(c) {
			handle(line, false)
		}
	})
	child.OnStderr(func(c string) {
		if d.o.OnStderr != nil {
			d.o.OnStderr(c)
		}
	})
	withUsage := func(r *util.Obj) *util.Obj {
		if usage != nil {
			r.Set("usage", usage)
		}
		return r
	}
	finish := func(code *int, err error, signal string) {
		if settled {
			return
		}
		settled = true
		offAbort()
		if d.child == child {
			d.child = nil
		}
		rest := lines.Take()
		if clisdk.JSTrim(rest) != "" {
			handle(rest, true) // 抛出（JSThrow）时沿 close 监听者向上（jsrt.Dispatch），本轮不 settle，与 Node 同
		}
		if err != nil {
			p.Reject(err)
			return
		}
		aborted := errors.New(strOr(d.o.AbortedMessage, "aborted"))
		codeNZ := code != nil && *code != 0
		exitMsg := func() string {
			if lastError != nil {
				return *lastError
			}
			if d.o.ExitMessage != nil {
				return d.o.ExitMessage(code) // exitMessage 返回 string（非 undefined）
			}
			return "exit code " + util.FormatNumber(float64(*code))
		}
		if strict {
			if !completed && (d.stopped || (d.o.StopRequested != nil && d.o.StopRequested()) || signal != "") {
				p.Reject(aborted)
				return
			}
			var silent *string
			if count == 0 && !codeNZ && d.o.SilentExit != nil {
				silent = d.o.SilentExit()
			}
			if silent != nil && *silent != "" {
				p.Reject(errors.New(*silent))
				return
			}
			if codeNZ && !completed {
				p.Reject(errors.New(exitMsg()))
				return
			}
			if lastError != nil && clisdk.JSTrim(text) == "" {
				p.Reject(errors.New(*lastError))
				return
			}
			p.Resolve(withUsage(O("turnId", turnID, "stopReason", "end_turn", "text", text, "sessionId", nullable(d.sid))))
			return
		}
		if d.stopped && text == "" {
			p.Reject(aborted)
			return
		}
		if codeNZ && text == "" {
			p.Reject(errors.New(exitMsg()))
			return
		}
		stop := "end_turn"
		if d.stopped {
			stop = "cancelled"
		} else if codeNZ {
			stop = "exited"
		}
		r := withUsage(O("turnId", turnID, "stopReason", stop, "text", text, "sessionId", nullable(d.sid)))
		if lastError != nil && text == "" {
			r.Set("error", *lastError)
		}
		p.Resolve(r)
	}
	child.OnError(func(e error) { finish(nil, e, "") })
	child.OnClose(func(code *int, signal string) { finish(code, nil, signal) })
	func() {
		defer func() { _ = recover() }()
		if d.o.Stdin != nil {
			if data := d.o.Stdin(input); data != nil && *data != "" {
				child.Stdin().Write(*data)
			}
		}
		if !d.o.KeepStdin {
			child.Stdin().End()
		}
	}()
	return p
}

func (d *ExecDriver) Interrupt() *jsrt.Promise[struct{}] {
	child := d.child
	if child == nil {
		return jsrt.Resolved(struct{}{})
	}
	d.stopped = true
	func() {
		defer func() { _ = recover() }()
		if !child.Killed() && child.ExitCode() == nil {
			if d.o.Kill != nil {
				d.o.Kill(child)
			} else {
				child.Kill("")
			}
		}
	}()
	return jsrt.Resolved(struct{}{})
}

func (d *ExecDriver) Close() *jsrt.Promise[struct{}] {
	d.Interrupt()
	d.ended = true
	d.hub.End()
	return jsrt.Resolved(struct{}{})
}
