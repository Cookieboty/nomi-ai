package drivers

import (
	"errors"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

var appApprovals = map[string]bool{
	"item/commandExecution/requestApproval": true,
	"item/fileChange/requestApproval":       true,
}

// AppServerDriverOptions mirrors AppServerDriverOptions。
type AppServerDriverOptions struct {
	Child              clisdk.ChildLike
	RPC                rpc.ConnectionOptions
	Kill               clisdk.KillFn
	PermissionIDPrefix *string
	ClientInfo         Json
	MapItem            func(phase string, item Json) []Json
	NewID              func() string
}

type appTurn struct {
	localID      string
	serverID     *string
	started      *jsrt.Promise[struct{}]
	text         string
	lastItem     *string
	totalsBefore *CodexTokenTotals
	lastError    *string
	settled      bool
	p            *jsrt.Promise[TurnResult]
}

// AppServerDriver mirrors AppServerDriver。
type AppServerDriver struct {
	Conn      *rpc.Connection
	o         AppServerDriverOptions
	hub       *clisdk.EventHub
	perms     map[string]*jsrt.Promise[Json]
	permOrder []string
	turn      *appTurn
	exited    bool
	ThreadID  *string
	Totals    *CodexTokenTotals
	Context   Json // nil = null
}

func NewAppServerDriver(o AppServerDriverOptions) *AppServerDriver {
	d := &AppServerDriver{o: o, hub: clisdk.NewEventHub(), perms: map[string]*jsrt.Promise[Json]{}}
	d.Conn = rpc.NewConnection(o.Child, rpc.Handlers{OnNotification: d.onNotification, OnRequest: d.onRequest}, o.RPC)
	o.Child.OnClose(func(code *int, _ string) {
		d.exited = true
		d.cancelPermissions()
		turn := d.turn
		d.turn = nil
		if turn != nil && !turn.settled {
			turn.settled = true
			msg := "app-server process exited"
			if turn.lastError != nil {
				msg = *turn.lastError
			}
			turn.p.Reject(errors.New(msg))
		}
		var c any
		if code != nil {
			c = float64(*code)
		}
		d.hub.Emit(O("kind", "health", "state", "exited", "code", c))
		d.hub.End()
	})
	return d
}

func (d *AppServerDriver) Events() *clisdk.Iter            { return d.hub.Iterate() }
func (d *AppServerDriver) On(fn func(SessionEvent)) func() { return d.hub.On(fn) }
func (d *AppServerDriver) SessionID() *string              { return d.ThreadID }
func (d *AppServerDriver) Closed() bool                    { return d.exited || d.Conn.IsClosed() }
func (d *AppServerDriver) InTurn() bool                    { return d.turn != nil }
func (d *AppServerDriver) CurrentTurnID() *string {
	if d.turn == nil {
		return nil
	}
	return d.turn.serverID
}

func (d *AppServerDriver) emit(ev Json) {
	turn := d.turn
	if turn != nil {
		turn.text = clisdk.AppendText(turn.text, ev)
	}
	e := O("kind", "harness", "event", ev)
	if turn != nil {
		e.Set("turnId", turn.localID)
	}
	d.hub.Emit(e)
}

// threadEq：JS `params.threadId === this.threadId`（缺键 = undefined，不等于 null）。
func (d *AppServerDriver) threadEq(params Json) bool {
	if !params.Has("threadId") {
		return false
	}
	v := params.Get("threadId")
	if d.ThreadID == nil {
		return v == nil
	}
	s, ok := v.(string)
	return ok && s == *d.ThreadID
}

func (d *AppServerDriver) onNotification(method string, params Json) {
	if method == "thread/tokenUsage/updated" && d.threadEq(params) {
		if t := CodexTokenTotalsOf(params.Get("tokenUsage")); t != nil {
			d.Totals = t
		}
		ctx := CodexLastContext(params.Get("tokenUsage"))
		if ctx != nil {
			d.Context = ctx
		}
		if d.turn != nil && ctx != nil && util.Truthy(ctx.Get("contextTokens")) {
			ev := O("type", "context", "tokens", ctx.Get("contextTokens"))
			if util.Truthy(ctx.Get("contextWindow")) {
				ev.Set("window", ctx.Get("contextWindow"))
			}
			d.emit(ev)
		}
		return
	}
	turn := d.turn
	if turn == nil || (params.Has("threadId") && !d.threadEq(params)) {
		return
	}
	switch method {
	case "turn/started":
		// thread/compact/start 的应答不带轮次 id：从 turn/started 取（停止、匹配 turn/completed 要用）
		if id, ok := getp(params.Get("turn"), "id").(string); ok && (turn.serverID == nil || *turn.serverID == "") {
			turn.serverID = &id
		}
	case "item/agentMessage/delta":
		var itemID *string
		if s, ok := params.Get("itemId").(string); ok {
			itemID = &s
		}
		delta, _ := params.Get("delta").(string)
		if !eqStrPtr(itemID, turn.lastItem) && strings.TrimSpace(turn.text) != "" {
			d.emit(O("type", "text-delta", "text", "\n\n"))
		}
		turn.lastItem = itemID
		if delta != "" {
			d.emit(O("type", "text-delta", "text", delta))
		}
	case "item/started", "item/completed":
		item, _ := params.Get("item").(*util.Obj)
		if params.Get("item") == nil {
			item = O()
		}
		// 上下文压缩（v2 ThreadItem contextCompaction）：开始 → 压缩中；完成 → 清状态，旧占用作废，
		// 等下一次 thread/tokenUsage/updated 带上压缩后的占用
		if item != nil && item.Get("type") == "contextCompaction" {
			if method == "item/started" {
				d.emit(O("type", "status", "kind", "compact"))
			} else {
				d.emit(O("type", "status", "kind", "clear"))
				d.emit(O("type", "context", "tokens", nil))
			}
			return
		}
		if d.o.MapItem != nil {
			phase := "completed"
			if method == "item/started" {
				phase = "started"
			}
			for _, ev := range d.o.MapItem(phase, item) {
				d.emit(ev)
			}
		}
	case "thread/compacted":
		// 旧版只发 thread/compacted（已弃用，新版改发 contextCompaction 条目）：只清状态
		d.emit(O("type", "status", "kind", "clear"))
	case "error":
		err := params.Get("error")
		message, ok := getp(err, "message").(string)
		if !ok {
			message = "app-server error"
		}
		if params.Get("willRetry") == true {
			d.emit(O("type", "status", "kind", "reconnect", "text", message))
		} else {
			turn.lastError = &message
		}
	case "turn/completed":
		done := params.Get("turn")
		if done == nil {
			done = O()
		}
		if turn.serverID != nil && *turn.serverID != "" {
			if s, ok := getp(done, "id").(string); !ok || s != *turn.serverID {
				return
			}
		}
		d.finish(turn, done)
	}
}

func eqStrPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (d *AppServerDriver) finish(turn *appTurn, done any) {
	if d.turn == turn {
		d.turn = nil
	}
	d.cancelPermissions()
	if turn.settled {
		return
	}
	turn.settled = true
	status, ok := getp(done, "status").(string)
	if !ok {
		status = "completed"
	}
	turnUsage := CodexTurnUsage(turn.totalsBefore, d.Totals)
	usage := turnUsage
	if turnUsage != nil && d.Context != nil {
		usage = O()
		usage.Assign(turnUsage)
		usage.Assign(d.Context)
	}
	var tid any
	if d.ThreadID != nil {
		tid = *d.ThreadID
	}
	r := O("turnId", turn.localID, "stopReason", status, "text", turn.text, "sessionId", tid)
	if turn.serverID != nil && *turn.serverID != "" {
		r.Set("cliTurnId", *turn.serverID)
	} else if turn.serverID == nil {
		if s, ok := getp(done, "id").(string); ok && s != "" {
			r.Set("cliTurnId", s)
		}
	}
	if status == "failed" {
		// Node：`error: msg || lastError || undefined`；undefined 时键存在但 JSON 省略，这里不设（读值等价）
		if m, ok := getp(getp(done, "error"), "message").(string); ok && m != "" {
			r.Set("error", m)
		} else if turn.lastError != nil && *turn.lastError != "" {
			r.Set("error", *turn.lastError)
		}
	}
	if usage != nil && status == "completed" {
		r.Set("usage", usage)
	}
	r.Set("raw", done)
	turn.p.Resolve(r)
}

var rejectRe = regexp.MustCompile(`^reject|^decline|^deny`)

func (d *AppServerDriver) onRequest(method string, params Json) *jsrt.Promise[any] {
	if !appApprovals[method] {
		return jsrt.Rejected[any](errors.New("unsupported client method " + method))
	}
	id := strOr(d.o.PermissionIDPrefix, "codex-perm-") + pick(d.o.NewID)()
	ap := jsrt.NewPromise[Json]()
	d.perms[id] = ap
	d.permOrder = append(d.permOrder, id)
	e := O("kind", "permission", "id", id, "request", O("summary", CodexApprovalSummary(method, params), "method", method))
	if d.turn != nil {
		e.Set("turnId", d.turn.localID)
	}
	d.hub.Emit(e)
	return jsrt.Async(func() (any, error) {
		answer, _ := jsrt.Await(ap)
		d.deletePerm(id)
		var decision string
		if answer.Has("optionId") {
			if rejectRe.MatchString(util.JSString(answer.Get("optionId"))) {
				decision = "decline"
			} else {
				decision = "accept"
			}
		} else {
			switch answer.Get("decision") {
			case "cancel":
				decision = "cancel"
			case "allow":
				decision = "accept"
			default:
				decision = "decline"
			}
		}
		return O("decision", decision), nil
	})
}

func (d *AppServerDriver) deletePerm(id string) {
	delete(d.perms, id)
	for i, x := range d.permOrder {
		if x == id {
			d.permOrder = append(d.permOrder[:i:i], d.permOrder[i+1:]...)
			return
		}
	}
}

func (d *AppServerDriver) RespondPermission(id string, answer Json) bool {
	p := d.perms[id]
	if p == nil {
		return false
	}
	p.Resolve(answer)
	return true
}

func (d *AppServerDriver) HasPermission(id string) bool { return d.perms[id] != nil }

func (d *AppServerDriver) cancelPermissions() {
	for _, id := range append([]string{}, d.permOrder...) {
		if p := d.perms[id]; p != nil {
			p.Resolve(O("decision", "cancel"))
		}
	}
}

func threadIDOf(r any) (string, bool) {
	s, ok := getp(getp(r, "thread"), "id").(string)
	return s, ok
}

func (d *AppServerDriver) Start(o clisdk.StartOptions) *jsrt.Promise[StartResult] {
	return jsrt.Async(func() (StartResult, error) {
		opts := sigOpts(o.Signal)
		ci := d.o.ClientInfo
		if ci == nil {
			ci = O("name", "nomi", "title", "Nomi", "version", "1")
		}
		init, err := jsrt.Await(d.Conn.Request("initialize", O("clientInfo", ci, "capabilities", nil), opts))
		if err != nil {
			return nil, err
		}
		d.Conn.Notify("initialized", O())
		resume := o.ResumeID != nil && *o.ResumeID != ""
		if resume {
			r, err := jsrt.Await(d.Conn.Request("thread/resume", O("threadId", *o.ResumeID, "cwd", o.Cwd), opts))
			if err != nil {
				return nil, err
			}
			// `r?.thread?.id ?? resumeId`：非字符串 id 原样保留（D-B7 acp 同类）
			if v := getp(getp(r, "thread"), "id"); v != nil {
				s := util.JSString(v)
				d.ThreadID = &s
			} else {
				s := *o.ResumeID
				d.ThreadID = &s
			}
		}
		d.hub.Emit(O("kind", "health", "state", "ready"))
		var sid any
		if d.ThreadID != nil {
			sid = *d.ThreadID
		}
		res := O("sessionId", sid)
		if resume {
			res.Set("resumed", true)
		}
		if ua, ok := getp(init, "userAgent").(string); ok {
			res.Set("version", ua)
		}
		res.Set("capabilities", O("loadSession", true, "images", true))
		return res, nil
	})
}

func (d *AppServerDriver) EnsureThread(cwd string) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) {
		if d.ThreadID != nil && *d.ThreadID != "" {
			return *d.ThreadID, nil
		}
		r, err := jsrt.Await(d.Conn.Request("thread/start", O("cwd", cwd), rpc.RequestOptions{}))
		if err != nil {
			return "", err
		}
		d.ThreadID = nil
		if v := getp(getp(r, "thread"), "id"); v != nil {
			s := util.JSString(v)
			d.ThreadID = &s
		}
		if d.ThreadID == nil || *d.ThreadID == "" {
			return "", errors.New("app-server returned no thread")
		}
		return *d.ThreadID, nil
	})
}

func (d *AppServerDriver) Send(input TurnInput) *jsrt.Promise[TurnResult] {
	if d.ThreadID == nil || *d.ThreadID == "" {
		return jsrt.Rejected[TurnResult](errors.New("app-server thread not started"))
	}
	var in any
	if input.Blocks != nil {
		in = input.Blocks
	} else {
		in = []any{O("type", "text", "text", input.Text, "text_elements", []any{})}
	}
	params := O("threadId", *d.ThreadID, "input", in)
	if input.Params != nil {
		params.Assign(input.Params)
	}
	return d.startTurn("turn/start", params)
}

// Compact mirrors compact：手动压缩上下文（thread/compact/start，应答为空对象）。服务端把它当作一轮
// （turn/started → contextCompaction 条目 → turn/completed），结束方式与 Send 相同；轮次 id 从 turn/started 取。
func (d *AppServerDriver) Compact() *jsrt.Promise[TurnResult] {
	if d.ThreadID == nil || *d.ThreadID == "" {
		return jsrt.Rejected[TurnResult](errors.New("app-server thread not started"))
	}
	return d.startTurn("thread/compact/start", O("threadId", *d.ThreadID))
}

func (d *AppServerDriver) startTurn(method string, params Json) *jsrt.Promise[TurnResult] {
	if d.turn != nil {
		return jsrt.Rejected[TurnResult](errors.New("previous turn still running"))
	}
	turn := &appTurn{localID: pick(d.o.NewID)(), started: jsrt.NewPromise[struct{}](), totalsBefore: d.Totals, p: jsrt.NewPromise[TurnResult]()}
	d.turn = turn
	req := d.Conn.Request(method, params, rpc.RequestOptions{})
	jsrt.Go(func() {
		r, err := jsrt.Await(req)
		if err == nil {
			if v := getp(getp(r, "turn"), "id"); v != nil {
				s := util.JSString(v)
				turn.serverID = &s
			}
			turn.started.Resolve(struct{}{})
			return
		}
		turn.started.Resolve(struct{}{})
		if d.turn == turn {
			d.turn = nil
		}
		if turn.settled {
			return
		}
		turn.settled = true
		turn.p.Reject(errors.New(rpc.InnermostMessage(err.Error())))
	})
	return turn.p
}

func (d *AppServerDriver) Interrupt() *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		d.cancelPermissions()
		turn := d.turn
		if turn == nil {
			return struct{}{}, nil
		}
		jsrt.Await(turn.started)
		if turn.settled || d.turn != turn || turn.serverID == nil || *turn.serverID == "" || d.ThreadID == nil || *d.ThreadID == "" {
			return struct{}{}, nil
		}
		_, err := jsrt.Await(d.Conn.Request("turn/interrupt", O("threadId", *d.ThreadID, "turnId", *turn.serverID), rpc.RequestOptions{}))
		return struct{}{}, err
	})
}

func (d *AppServerDriver) Close() *jsrt.Promise[struct{}] {
	d.cancelPermissions()
	clisdk.EndChild(d.o.Child, d.o.Kill)
	return jsrt.Resolved(struct{}{})
}
