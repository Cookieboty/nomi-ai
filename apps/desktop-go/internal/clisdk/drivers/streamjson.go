package drivers

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const ControlTimeoutMs = 10_000

// StreamJsonMessages mirrors messages?（nil 字段 = undefined）。
type StreamJsonMessages struct{ Timeout, NotWritable, Exited, Rejected *string }

// StreamJsonDriverOptions mirrors StreamJsonDriverOptions。
type StreamJsonDriverOptions struct {
	Child            clisdk.ChildLike
	ParseLine        func(line string) []Ev
	OnLine           func(line string, final bool) bool
	Messages         StreamJsonMessages
	ControlTimeoutMs int // 0 = undefined
	DenyMessage      *string
	ResumeID         *string
	Kill             clisdk.KillFn
	NewID            func() string
}

type controlWaiter struct {
	p     *jsrt.Promise[*util.Obj]
	timer *jsrt.Timer
}

type streamTurn struct {
	id        string
	text      string
	sessionID *string
	lastError *string
	settled   bool
	p         *jsrt.Promise[TurnResult]
}

// StreamJsonDriver mirrors StreamJsonDriver。构造需持 jsrt 锁。
type StreamJsonDriver struct {
	o        StreamJsonDriverOptions
	hub      *clisdk.EventHub
	controls map[string]*controlWaiter
	asks     map[string]bool
	lines    clisdk.LineSplitter
	turn     *streamTurn
	sid      *string
	exited   bool
}

func NewStreamJsonDriver(o StreamJsonDriverOptions) *StreamJsonDriver {
	d := &StreamJsonDriver{o: o, hub: clisdk.NewEventHub(), controls: map[string]*controlWaiter{}, asks: map[string]bool{}, sid: o.ResumeID}
	o.Child.OnStdout(func(chunk string) {
		for _, line := range d.lines.Push(chunk) {
			d.onLine(line, false)
		}
	})
	o.Child.OnError(func(e error) { d.onExit(nil, e) })
	o.Child.OnClose(func(code *int, _ string) {
		if rest := d.lines.Take(); clisdk.JSTrim(rest) != "" {
			d.onLine(rest, true)
		}
		d.onExit(code, nil)
	})
	return d
}

func (d *StreamJsonDriver) Events() *clisdk.Iter            { return d.hub.Iterate() }
func (d *StreamJsonDriver) On(fn func(SessionEvent)) func() { return d.hub.On(fn) }
func (d *StreamJsonDriver) SessionID() *string              { return d.sid }
func (d *StreamJsonDriver) Closed() bool                    { return d.exited }
func (d *StreamJsonDriver) InTurn() bool                    { return d.turn != nil }

func (d *StreamJsonDriver) id() string { return pick(d.o.NewID)() }

func (d *StreamJsonDriver) onExit(code *int, err error) {
	if d.exited {
		return
	}
	d.exited = true
	if err != nil {
		d.failControls(err)
	} else {
		d.failControls(errors.New(strOr(d.o.Messages.Exited, "process exited")))
	}
	d.asks = map[string]bool{}
	turn := d.turn
	d.turn = nil
	if turn != nil && !turn.settled {
		turn.settled = true
		codeNZ := code != nil && *code != 0
		if err != nil {
			turn.p.Reject(err)
		} else if codeNZ && turn.text == "" {
			turn.p.Reject(errors.New(strOr(turn.lastError, "exit code "+util.FormatNumber(float64(*code)))))
		} else {
			stop := "end_turn"
			if codeNZ {
				stop = "exited"
			}
			sid := turn.sessionID
			if sid == nil {
				sid = d.sid
			}
			turn.p.Resolve(O("turnId", turn.id, "stopReason", stop, "text", turn.text, "sessionId", nullable(sid)))
		}
	}
	var c any
	if code != nil {
		c = float64(*code)
	}
	d.hub.Emit(O("kind", "health", "state", "exited", "code", c))
	d.hub.End()
}

func (d *StreamJsonDriver) onLine(line string, final bool) {
	if clisdk.JSTrim(line) == "" {
		return
	}
	if strings.Contains(line, `"control_response"`) && d.onControlResponse(line) {
		return
	}
	if d.o.OnLine != nil && d.o.OnLine(line, final) {
		return
	}
	turn := d.turn
	for _, ev := range d.o.ParseLine(line) {
		if ev.Get("type") == "permission" {
			id := util.Str(ev.Get("id"))
			d.asks[id] = true
			req := clisdk.WithOpt(O(), "summary", ev.Get("summary"))
			if util.Truthy(ev.Get("toolUseId")) {
				req.Set("toolUseId", ev.Get("toolUseId"))
			}
			e := clisdk.WithOpt(O("kind", "permission"), "id", ev.Get("id"))
			e.Set("request", req)
			if turn != nil {
				e.Set("turnId", turn.id)
			}
			d.hub.Emit(e)
		}
		if turn != nil {
			turn.text = clisdk.AppendText(turn.text, ev)
			if ev.Get("type") == "error" {
				if m, ok := ev.Get("message").(string); ok {
					turn.lastError = &m
				} else {
					turn.lastError = nil
				}
			}
		}
		he := O("kind", "harness", "event", ev)
		if turn != nil {
			he.Set("turnId", turn.id)
		}
		d.hub.Emit(he)
		if ev.Get("type") == "done" {
			if s, ok := ev.Get("sessionId").(string); ok && s != "" {
				d.sid = &s
			}
			if turn != nil && !turn.settled {
				turn.settled = true
				d.turn = nil
				r := O("turnId", turn.id, "stopReason", "end_turn")
				if turn.text != "" {
					r.Set("text", turn.text)
				} else if ev.Has("text") {
					r.Set("text", ev.Get("text"))
				}
				if ev.Has("sessionId") && ev.Get("sessionId") != nil {
					r.Set("sessionId", ev.Get("sessionId"))
				} else {
					r.Set("sessionId", nullable(d.sid))
				}
				if util.Truthy(ev.Get("usage")) {
					r.Set("usage", ev.Get("usage"))
				}
				turn.p.Resolve(r)
			}
		}
	}
}

func (d *StreamJsonDriver) onControlResponse(line string) bool {
	v, err := util.ParseString(line)
	if err != nil {
		return false
	}
	j, _ := v.(*util.Obj)
	if j == nil || j.Get("type") != "control_response" {
		// JSON.parse 得到非对象：j.type 为 undefined → false
		return false
	}
	r, _ := j.Get("response").(*util.Obj)
	if r == nil {
		r = O()
	}
	requestID, _ := r.Get("request_id").(string)
	w := d.controls[requestID]
	if w == nil {
		return true
	}
	delete(d.controls, requestID)
	jsrt.ClearTimeout(w.timer)
	if r.Get("subtype") == "success" {
		resp, _ := r.Get("response").(*util.Obj)
		if resp == nil {
			resp = O()
		}
		w.p.Resolve(resp)
	} else if s, ok := r.Get("error").(string); ok && s != "" {
		w.p.Reject(errors.New(s))
	} else {
		w.p.Reject(errors.New(strOr(d.o.Messages.Rejected, "request rejected")))
	}
	return true
}

func (d *StreamJsonDriver) write(obj any) (ok bool) {
	if d.exited || !d.o.Child.Stdin().Writable() {
		return false
	}
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	d.o.Child.Stdin().Write(util.Stringify(obj) + "\n")
	return true
}

// Control mirrors control()。
func (d *StreamJsonDriver) Control(request *util.Obj) *jsrt.Promise[*util.Obj] {
	requestID := d.id()
	p := jsrt.NewPromise[*util.Obj]()
	ms := d.o.ControlTimeoutMs
	if ms == 0 {
		ms = ControlTimeoutMs
	}
	timer := jsrt.SetTimeout(time.Duration(ms)*time.Millisecond, func() {
		delete(d.controls, requestID)
		p.Reject(errors.New(strOr(d.o.Messages.Timeout, "control request timed out")))
	})
	d.controls[requestID] = &controlWaiter{p: p, timer: timer}
	if !d.write(O("type", "control_request", "request_id", requestID, "request", request)) {
		jsrt.ClearTimeout(timer)
		delete(d.controls, requestID)
		p.Reject(errors.New(strOr(d.o.Messages.NotWritable, "stdin not writable")))
	}
	return p
}

func (d *StreamJsonDriver) NotifyControl(request *util.Obj) bool {
	return d.write(O("type", "control_request", "request_id", d.id(), "request", request))
}

func (d *StreamJsonDriver) failControls(e error) {
	for _, w := range d.controls {
		jsrt.ClearTimeout(w.timer)
		w.p.Reject(e)
	}
	d.controls = map[string]*controlWaiter{}
}

func (d *StreamJsonDriver) Start(string, *string, *jsrt.AbortSignal) *jsrt.Promise[StartResult] {
	return jsrt.Resolved(O("sessionId", nullable(d.sid), "capabilities", O("images", true)))
}

// WriteUser mirrors writeUser（uuid 为空串 = 默认）。
func (d *StreamJsonDriver) WriteUser(content any, uuid string) bool {
	if uuid == "" {
		uuid = d.id()
	}
	return d.write(O("type", "user", "uuid", uuid, "message", O("role", "user", "content", content)))
}

func (d *StreamJsonDriver) Send(input TurnInput) *jsrt.Promise[TurnResult] {
	if d.turn != nil {
		return jsrt.Rejected[TurnResult](errors.New("previous turn still running"))
	}
	p := jsrt.NewPromise[TurnResult]()
	turn := &streamTurn{id: d.id(), sessionID: d.sid, p: p}
	d.turn = turn
	var content any = input.Text
	if input.Blocks != nil {
		content = input.Blocks
	}
	if !d.WriteUser(content, turn.id) {
		d.turn = nil
		p.Reject(errors.New("stdin not writable"))
	}
	return p
}

func (d *StreamJsonDriver) Interrupt() *jsrt.Promise[struct{}] {
	c := d.Control(O("subtype", "interrupt"))
	return jsrt.Async(func() (struct{}, error) { _, err := jsrt.Await(c); return struct{}{}, err })
}

func (d *StreamJsonDriver) SetPermissionMode(mode string) *jsrt.Promise[string] {
	c := d.Control(O("subtype", "set_permission_mode", "mode", mode))
	return jsrt.Async(func() (string, error) { _, err := jsrt.Await(c); return "applied", err })
}

func (d *StreamJsonDriver) SetModel(model *string, _ *string) *jsrt.Promise[string] {
	c := d.Control(O("subtype", "set_model", "model", strOr(model, "default")))
	return jsrt.Async(func() (string, error) { _, err := jsrt.Await(c); return "applied", err })
}

var rejectOrDeny = regexp.MustCompile(`^reject|^deny`)

// RespondPermission mirrors respondPermission（answer：{optionId} / {decision, updatedInput?}）。
func (d *StreamJsonDriver) RespondPermission(id string, answer *util.Obj) bool {
	if !d.asks[id] && !d.o.Child.Stdin().Writable() {
		return false
	}
	delete(d.asks, id)
	var allow bool
	if answer.Has("optionId") {
		allow = !rejectOrDeny.MatchString(util.JSString(answer.Get("optionId")))
	} else {
		allow = answer.Get("decision") == "allow"
	}
	var response *util.Obj
	if allow {
		response = O("behavior", "allow")
		if answer.Has("updatedInput") {
			response.Set("updatedInput", answer.Get("updatedInput"))
		}
	} else {
		response = O("behavior", "deny", "message", strOr(d.o.DenyMessage, "The user did not allow this call"))
	}
	return d.write(O("type", "control_response", "response", O("subtype", "success", "request_id", id, "response", response)))
}

func (d *StreamJsonDriver) Close() *jsrt.Promise[struct{}] {
	d.failControls(errors.New(strOr(d.o.Messages.Exited, "process exited")))
	clisdk.EndChild(d.o.Child, d.o.Kill)
	return jsrt.Resolved(struct{}{})
}
