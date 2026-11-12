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

// AppServerDriverOptions：app-server 驱动选项。
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

// AppServerDriver：Codex app-server 会话驱动。
type AppServerDriver struct {
	Conn          *rpc.Connection
	o             AppServerDriverOptions
	hub           *clisdk.EventHub
	perms         map[string]*jsrt.Promise[Json]
	permOrder     []string
	questions     map[string]*jsrt.Promise[Json]
	questionOrder []string
	turn          *appTurn
	exited        bool
	ThreadID      *string
	Totals        *CodexTokenTotals
	Context       Json // nil = null
	// 压缩完成后还没收到新占用：旧 contextTokens 已作废。结束这一轮时在 usage 里写 contextTokens = 0，
	// 落盘的消息就带着「压缩后大小未知」的边界，视图不会回扫到压缩前的值（#217）
	contextStale bool
}

func NewAppServerDriver(o AppServerDriverOptions) *AppServerDriver {
	d := &AppServerDriver{
		o: o, hub: clisdk.NewEventHub(),
		perms: map[string]*jsrt.Promise[Json]{}, questions: map[string]*jsrt.Promise[Json]{},
	}
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
			if util.Truthy(ctx.Get("contextTokens")) {
				d.contextStale = false
			}
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
				var window any
				if d.Context != nil {
					window = d.Context.Get("contextWindow")
				}
				d.Context = nil
				if util.Truthy(window) {
					d.Context = O("contextWindow", window)
				}
				d.contextStale = true
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
	if d.contextStale && status == "completed" {
		next := O()
		if usage != nil {
			next.Assign(usage)
		}
		next.Set("contextTokens", 0)
		usage = next
		d.contextStale = false
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
		// `error: msg || lastError || undefined`；undefined 时键存在但 JSON 省略，这里不设（读值等价）
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

// errQuestionCancelled：用户取消、停止这一轮或进程退出时，request_user_input 没有「取消」结果体，
// 用 JSON-RPC 错误告诉 Codex 这次提问被取消了（空 answers 会让模型当成没选、继续往下做）。
var errQuestionCancelled = errors.New("cancelled")

func (d *AppServerDriver) onRequest(method string, params Json) *jsrt.Promise[any] {
	switch method {
	case "item/tool/requestUserInput":
		return d.beginQuestion(method, params)
	case "mcpServer/elicitation/request":
		mode, approval := codexElicitationKind(params)
		switch {
		case approval:
			return d.beginPermission(method, params, true)
		case mode == "form" || mode == "openai/form":
			return d.beginQuestion(method, params)
		default:
			// URL 和认不出的模式：不挂起这一轮。没有打开外部链接的界面，按取消回。
			return jsrt.Resolved[any](O("action", "cancel", "content", nil))
		}
	}
	if !appApprovals[method] {
		return jsrt.Rejected[any](errors.New("unsupported client method " + method))
	}
	return d.beginPermission(method, params, false)
}

// codexElicitationKind：请求体在 params.request 上。工具审批（codex_approval_kind）走允许 / 拒绝。
func codexElicitationKind(params Json) (mode string, approval bool) {
	body := params
	if req, ok := params.Get("request").(*util.Obj); ok && req != nil &&
		(req.Has("mode") || req.Has("requestedSchema") || req.Has("message")) {
		body = req
	}
	mode, _ = body.Get("mode").(string)
	meta, _ := body.Get("_meta").(*util.Obj)
	if meta == nil {
		meta, _ = body.Get("meta").(*util.Obj)
	}
	if meta != nil && meta.Get("codex_approval_kind") == "mcp_tool_call" {
		approval = true
	}
	return mode, approval
}

func (d *AppServerDriver) beginQuestion(method string, params Json) *jsrt.Promise[any] {
	id := strOr(d.o.PermissionIDPrefix, "codex-perm-") + pick(d.o.NewID)()
	ap := jsrt.NewPromise[Json]()
	d.questions[id] = ap
	d.questionOrder = append(d.questionOrder, id)
	e := O("kind", "question", "id", id, "method", method, "params", params)
	if d.turn != nil {
		e.Set("turnId", d.turn.localID)
	}
	d.hub.Emit(e)
	return jsrt.Async(func() (any, error) {
		answer, err := jsrt.Await(ap)
		d.deleteQuestion(id)
		if err != nil {
			return nil, err
		}
		if answer == nil {
			answer = O()
		}
		return answer, nil
	})
}

func (d *AppServerDriver) beginPermission(method string, params Json, elicitation bool) *jsrt.Promise[any] {
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
		decision := permissionDecision(answer)
		if elicitation {
			action := "decline"
			switch decision {
			case "accept":
				action = "accept"
			case "cancel":
				action = "cancel"
			}
			return O("action", action, "content", nil), nil
		}
		return O("decision", decision), nil
	})
}

func permissionDecision(answer Json) string {
	if answer == nil {
		return "decline"
	}
	if answer.Has("optionId") {
		if rejectRe.MatchString(util.JSString(answer.Get("optionId"))) {
			return "decline"
		}
		return "accept"
	}
	switch answer.Get("decision") {
	case "cancel":
		return "cancel"
	case "allow":
		return "accept"
	default:
		return "decline"
	}
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

func (d *AppServerDriver) deleteQuestion(id string) {
	delete(d.questions, id)
	for i, x := range d.questionOrder {
		if x == id {
			d.questionOrder = append(d.questionOrder[:i:i], d.questionOrder[i+1:]...)
			return
		}
	}
}

// RespondQuestion：把问题卡的协议结果写回。cancel 为真时以错误结束（request_user_input 的取消）。
func (d *AppServerDriver) RespondQuestion(id string, body Json, cancel bool) bool {
	p := d.questions[id]
	if p == nil {
		return false
	}
	d.deleteQuestion(id)
	if cancel {
		p.Reject(errQuestionCancelled)
		return true
	}
	if body == nil {
		body = O()
	}
	p.Resolve(body)
	return true
}

func (d *AppServerDriver) cancelQuestions() {
	for _, id := range append([]string{}, d.questionOrder...) {
		if p := d.questions[id]; p != nil {
			d.deleteQuestion(id)
			p.Reject(errQuestionCancelled)
		}
	}
}

func (d *AppServerDriver) cancelPermissions() {
	for _, id := range append([]string{}, d.permOrder...) {
		if p := d.perms[id]; p != nil {
			p.Resolve(O("decision", "cancel"))
		}
	}
	d.cancelQuestions()
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
			// `r?.thread?.id ?? resumeId`：非字符串 id 原样保留
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

// Compact：手动压缩上下文（thread/compact/start，应答为空对象）。服务端把它当作一轮
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

// Steer：turn/steer 把用户消息追加进正在进行的这一轮（expectedTurnId 不匹配时服务端拒绝，返回 false）。
// 实测 0.164：立刻应答，模型取走时发出一个 userMessage 条目，同一轮继续。turn/start 的应答没回来时先等它。
func (d *AppServerDriver) Steer(text string) *jsrt.Promise[bool] {
	turn := d.turn
	if turn == nil || turn.settled || d.ThreadID == nil || *d.ThreadID == "" {
		return jsrt.Resolved(false)
	}
	return jsrt.Async(func() (bool, error) {
		jsrt.Await(turn.started)
		if turn.settled || d.turn != turn || turn.serverID == nil || *turn.serverID == "" {
			return false, nil
		}
		_, err := jsrt.Await(d.Conn.Request("turn/steer", O(
			"threadId", *d.ThreadID,
			"expectedTurnId", *turn.serverID,
			"input", []any{O("type", "text", "text", text, "text_elements", []any{})},
		), rpc.RequestOptions{}))
		return err == nil, nil
	})
}

func (d *AppServerDriver) Close() *jsrt.Promise[struct{}] {
	d.cancelPermissions()
	clisdk.EndChild(d.o.Child, d.o.Kill)
	return jsrt.Resolved(struct{}{})
}
