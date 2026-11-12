package drivers

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const AcpPromptIdleMs = 10 * 60_000

// xaiSessionNotify：Grok 的会话扩展通知（x.ai/session_notification 带 auto-compact）。
var xaiSessionNotify = regexp.MustCompile(`^_?x\.ai/session(?:_notification|/update)$`)

var _ = time.Millisecond

// AcpDriverOptions：ACP 驱动选项。
type AcpDriverOptions struct {
	Child              clisdk.ChildLike
	PermissionIDPrefix *string
	PromptIdleMs       *int
	RPC                rpc.ConnectionOptions
	Kill               clisdk.KillFn
	Mapper             func() AcpMapper
	ClientCapabilities Json
	NewID              func() string
	// SteerMethod：一轮进行中插入用户消息的扩展方法（ACP 本身没有），参数 {sessionId, text}。
	// Grok 1.0.70：`_x.ai/interject`，应答 {status:'queued'}，在下一个工具 / 模型步骤并进这一轮。
	// 空串 = 不支持（如 Gemini：新的 session/prompt 会中止当前这一轮）。
	SteerMethod string
}

type acpTurn struct {
	id     string
	mapper AcpMapper
	text   string
	denied bool
}

type pendingPerm struct {
	options []any
	raw     any
	p       *jsrt.Promise[Json]
}

func parseOptions(raw any) []any {
	arr, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for _, o := range arr {
		id, ok := getp(o, "optionId").(string)
		if !ok {
			continue
		}
		k, _ := getp(o, "kind").(string)
		e := O("id", id, "kind", k)
		if n, ok := getp(o, "name").(string); ok {
			e.Set("name", n)
		}
		out = append(out, e)
	}
	return out
}

func parseCommands(raw any) []any {
	arr, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for _, c := range arr {
		name, ok := getp(c, "name").(string)
		if !ok {
			continue
		}
		e := O("name", name)
		if d, ok := getp(c, "description").(string); ok {
			e.Set("description", d)
		}
		if h, ok := getp(getp(c, "input"), "hint").(string); ok {
			e.Set("hint", h)
		}
		out = append(out, e)
	}
	return out
}

// AcpDriver：ACP 会话驱动。构造需持 jsrt 锁。
type AcpDriver struct {
	Conn              *rpc.Connection
	o                 AcpDriverOptions
	hub               *clisdk.EventHub
	turn              *acpTurn
	perms             map[string]*pendingPerm
	permOrder         []string
	questions         map[string]*jsrt.Promise[Json]
	questionOrder     []string
	sid               *string
	exited            bool
	ModeID            *string
	AgentCapabilities Json
}

func NewAcpDriver(o AcpDriverOptions) *AcpDriver {
	d := &AcpDriver{
		o: o, hub: clisdk.NewEventHub(), perms: map[string]*pendingPerm{},
		questions: map[string]*jsrt.Promise[Json]{}, AgentCapabilities: O(),
	}
	d.Conn = rpc.NewConnection(o.Child, rpc.Handlers{
		OnNotification: d.onNotification,
		OnRequest:      d.onRequest,
	}, o.RPC)
	o.Child.OnClose(func(code *int, _ string) {
		d.exited = true
		d.cancelPermissions()
		var c any
		if code != nil {
			c = float64(*code)
		}
		d.hub.Emit(O("kind", "health", "state", "exited", "code", c))
		d.hub.End()
	})
	return d
}

func (d *AcpDriver) Events() *clisdk.Iter            { return d.hub.Iterate() }
func (d *AcpDriver) On(fn func(SessionEvent)) func() { return d.hub.On(fn) }
func (d *AcpDriver) SessionID() *string              { return d.sid }
func (d *AcpDriver) Closed() bool                    { return d.exited || d.Conn.IsClosed() }
func (d *AcpDriver) TurnDenied() bool                { return d.turn != nil && d.turn.denied }
func (d *AcpDriver) InTurn() bool                    { return d.turn != nil }

func (d *AcpDriver) onNotification(method string, params Json) {
	// Grok 的自动压缩走 x.ai 扩展通知（x.ai/session_notification；线上可能带 ACP 扩展前缀 _）。
	// 扩展通知里只取 auto_compact_*，其它内容与标准 session/update 重复
	ext := xaiSessionNotify.MatchString(method)
	if method != "session/update" && !ext {
		return
	}
	u, _ := params.Get("update").(*util.Obj)
	if u == nil {
		// (params.update ?? {})：非对象原始值读属性均为 undefined
		u = O()
	}
	if ext && !strings.HasPrefix(strQ(u.Get("sessionUpdate")), "auto_compact_") {
		return
	}
	if u.Get("sessionUpdate") == "available_commands_update" {
		d.hub.Emit(O("kind", "commands", "commands", parseCommands(u.Get("availableCommands"))))
		return
	}
	turn := d.turn
	var evs []Ev
	if turn != nil {
		evs = turn.mapper.Update(u)
	} else {
		evs = NewAcpMapper().Update(u)
	}
	for _, ev := range evs {
		if turn != nil {
			turn.text = clisdk.AppendText(turn.text, ev)
		}
		e := O("kind", "harness", "event", ev)
		if turn != nil {
			e.Set("turnId", turn.id)
		}
		d.hub.Emit(e)
	}
}

func (d *AcpDriver) onRequest(method string, params Json) *jsrt.Promise[any] {
	if method == "elicitation/create" {
		mode, _ := params.Get("mode").(string)
		if mode != "form" {
			// 只广告了 form。URL 和别的模式按协议拒绝，不挂住这一轮，也不当作用户点了取消。
			return jsrt.Rejected[any](errors.New("unsupported elicitation mode"))
		}
		return d.beginQuestion(method, params)
	}
	if method != "session/request_permission" {
		return jsrt.Rejected[any](errors.New("unsupported client method " + method))
	}
	id := strOr(d.o.PermissionIDPrefix, "acp-perm-") + pick(d.o.NewID)()
	options := parseOptions(params.Get("options"))
	call := params.Get("toolCall")
	ap := jsrt.NewPromise[Json]()
	d.perms[id] = &pendingPerm{options: options, raw: params.Get("options"), p: ap}
	d.permOrder = append(d.permOrder, id)
	req := O("summary", PermissionSummary(params))
	if t, ok := getp(call, "toolCallId").(string); ok {
		req.Set("toolUseId", t)
	}
	req.Set("options", options).Set("method", method)
	e := O("kind", "permission", "id", id, "request", req)
	if d.turn != nil {
		e.Set("turnId", d.turn.id)
	}
	d.hub.Emit(e)
	return jsrt.Async(func() (any, error) {
		answer, _ := jsrt.Await(ap)
		d.deletePerm(id)
		var optionID string
		var has bool
		if answer.Has("optionId") {
			optionID, has = answer.Get("optionId").(string)
			has = has && optionID != ""
		} else if answer.Get("decision") == "cancel" {
			has = false
		} else {
			allow := answer.Get("decision") == "allow"
			if !allow && d.turn != nil {
				d.turn.denied = true
			}
			optionID, has = PickPermissionOption(params.Get("options"), allow)
			has = has && optionID != ""
		}
		if has {
			return O("outcome", O("outcome", "selected", "optionId", optionID)), nil
		}
		return O("outcome", O("outcome", "cancelled")), nil
	})
}

func (d *AcpDriver) deletePerm(id string) {
	delete(d.perms, id)
	for i, x := range d.permOrder {
		if x == id {
			d.permOrder = append(d.permOrder[:i:i], d.permOrder[i+1:]...)
			return
		}
	}
}

func (d *AcpDriver) RespondPermission(id string, answer Json) bool {
	p := d.perms[id]
	if p == nil {
		return false
	}
	p.p.Resolve(answer)
	return true
}

func (d *AcpDriver) HasPermission(id string) bool { return d.perms[id] != nil }

func (d *AcpDriver) beginQuestion(method string, params Json) *jsrt.Promise[any] {
	id := strOr(d.o.PermissionIDPrefix, "acp-perm-") + pick(d.o.NewID)()
	ap := jsrt.NewPromise[Json]()
	d.questions[id] = ap
	d.questionOrder = append(d.questionOrder, id)
	e := O("kind", "question", "id", id, "method", method, "params", params)
	if d.turn != nil {
		e.Set("turnId", d.turn.id)
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

func (d *AcpDriver) deleteQuestion(id string) {
	delete(d.questions, id)
	for i, x := range d.questionOrder {
		if x == id {
			d.questionOrder = append(d.questionOrder[:i:i], d.questionOrder[i+1:]...)
			return
		}
	}
}

// RespondQuestion：把问题卡的协议结果写回 elicitation/create。
func (d *AcpDriver) RespondQuestion(id string, body Json, cancel bool) bool {
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

func (d *AcpDriver) cancelQuestions() {
	for _, id := range append([]string{}, d.questionOrder...) {
		if p := d.questions[id]; p != nil {
			d.deleteQuestion(id)
			p.Reject(errQuestionCancelled)
		}
	}
}

func (d *AcpDriver) cancelPermissions() {
	for _, id := range append([]string{}, d.permOrder...) {
		if p := d.perms[id]; p != nil {
			p.p.Resolve(O("decision", "cancel"))
		}
	}
	d.cancelQuestions()
}

func sigOpts(s *jsrt.AbortSignal) rpc.RequestOptions {
	return rpc.RequestOptions{Signal: s}
}

// acpClientCaps：会话握手广告 form elicitation（问题卡）。没广告的模式（URL）代理不该发。
// 调用方已经给了非空的 elicitation 对象时保留，不覆盖。
func acpClientCaps(caps Json) Json {
	if caps == nil {
		caps = O("fs", O("readTextFile", false, "writeTextFile", false))
	}
	if elic, ok := caps.Get("elicitation").(*util.Obj); ok && elic != nil {
		return caps
	}
	next := caps.Clone()
	next.Set("elicitation", O("form", O()))
	return next
}

func (d *AcpDriver) Start(o clisdk.StartOptions) *jsrt.Promise[StartResult] {
	return jsrt.Async(func() (StartResult, error) {
		opts := sigOpts(o.Signal)
		initV, err := jsrt.Await(d.Conn.Request("initialize", O("protocolVersion", float64(1), "clientCapabilities", acpClientCaps(d.o.ClientCapabilities)), opts))
		if err != nil {
			return nil, err
		}
		if ac, ok := getp(initV, "agentCapabilities").(*util.Obj); ok {
			d.AgentCapabilities = ac
		} else if v := getp(initV, "agentCapabilities"); v != nil {
			d.AgentCapabilities = O() // 非对象：后续属性读取均为 undefined
		} else {
			d.AgentCapabilities = O()
		}
		prompt := d.AgentCapabilities.Get("promptCapabilities")
		var mcp any = []any{}
		if o.McpServers != nil {
			mcp = o.McpServers
		}
		// 额外的根（ACP additionalDirectories，2026-06 稳定）：agent 声明支持才发，否则只在 cwd 里做
		withDirs := func(params *util.Obj) *util.Obj {
			if len(o.AdditionalDirectories) == 0 {
				return params
			}
			sc, _ := d.AgentCapabilities.Get("sessionCapabilities").(*util.Obj)
			if sc == nil || !util.Truthy(sc.Get("additionalDirectories")) {
				return params
			}
			dirs := make([]any, len(o.AdditionalDirectories))
			for i, x := range o.AdditionalDirectories {
				dirs[i] = x
			}
			return params.Set("additionalDirectories", dirs)
		}
		var sid *string
		var modeNow any
		resumed := false
		if o.ResumeID != nil && *o.ResumeID != "" {
			resumeID := *o.ResumeID
			r, err := jsrt.Await(d.Conn.Request("session/load", withDirs(O("sessionId", resumeID, "cwd", o.Cwd, "mcpServers", mcp)), opts))
			if err == nil {
				modeNow = getp(getp(r, "modes"), "currentModeId")
				resumed = true
				sid = &resumeID
			}
		}
		if sid == nil {
			r, err := jsrt.Await(d.Conn.Request("session/new", withDirs(O("cwd", o.Cwd, "mcpServers", mcp)), opts))
			if err != nil {
				return nil, err
			}
			// r?.sessionId ?? null：值按原样（类型声明为 string）
			if v := getp(r, "sessionId"); v != nil {
				if s, ok := v.(string); ok {
					sid = &s
				} else if util.Truthy(v) {
					s := util.JSString(v)
					sid = &s // 非字符串真值：转成字符串存入
				}
			}
			modeNow = getp(getp(r, "modes"), "currentModeId")
		}
		if sid == nil || *sid == "" {
			return nil, errors.New("ACP agent returned no session")
		}
		d.sid = sid
		if m, ok := modeNow.(string); ok {
			d.ModeID = &m
		}
		d.hub.Emit(O("kind", "health", "state", "ready"))
		res := O("sessionId", *sid)
		if o.ResumeID != nil && *o.ResumeID != "" {
			res.Set("resumed", resumed)
		}
		if m, ok := modeNow.(string); ok {
			res.Set("currentModeId", m)
		}
		if pv, ok := getp(initV, "protocolVersion").(float64); ok {
			res.Set("version", util.FormatNumber(pv))
		}
		res.Set("capabilities", O(
			"loadSession", d.AgentCapabilities.Get("loadSession") == true,
			"images", getp(prompt, "image") == true,
			"audio", getp(prompt, "audio") == true,
		))
		return res, nil
	})
}

func (d *AcpDriver) requireSession() (string, error) {
	if d.sid == nil || *d.sid == "" {
		return "", errors.New("ACP session not started")
	}
	return *d.sid, nil
}

func (d *AcpDriver) SetPermissionMode(modeID string) *jsrt.Promise[string] {
	return d.SetPermissionModeSignal(modeID, nil)
}

func (d *AcpDriver) SetPermissionModeSignal(modeID string, signal *jsrt.AbortSignal) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) {
		sid, err := d.requireSession()
		if err != nil {
			return "", err
		}
		if _, err := jsrt.Await(d.Conn.Request("session/set_mode", O("sessionId", sid, "modeId", modeID), sigOpts(signal))); err != nil {
			return "", err
		}
		d.ModeID = &modeID
		return "applied", nil
	})
}

func (d *AcpDriver) SetSessionModel(modelID string) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		sid, err := d.requireSession()
		if err != nil {
			return struct{}{}, err
		}
		_, err = jsrt.Await(d.Conn.Request("session/set_model", O("sessionId", sid, "modelId", modelID), rpc.RequestOptions{}))
		return struct{}{}, err
	})
}

func (d *AcpDriver) SetConfigOption(configID string, value any) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		sid, err := d.requireSession()
		if err != nil {
			return struct{}{}, err
		}
		_, err = jsrt.Await(d.Conn.Request("session/set_config_option", O("sessionId", sid, "configId", configID, "value", value), rpc.RequestOptions{}))
		return struct{}{}, err
	})
}

func (d *AcpDriver) SetModel(model, effort *string) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) {
		if model == nil && effort == nil {
			return "restart", nil
		}
		if model != nil && *model != "" {
			if _, err := jsrt.Await(d.SetSessionModel(*model)); err != nil {
				return "", err
			}
		}
		if effort != nil && *effort != "" {
			if _, err := jsrt.Await(d.SetConfigOption("reasoning_effort", *effort)); err != nil {
				return "", err
			}
		}
		return "applied", nil
	})
}

func (d *AcpDriver) Send(input TurnInput) *jsrt.Promise[TurnResult] {
	return d.runTurn("session/prompt", func(sessionID string) Json {
		var prompt any
		if input.Blocks != nil {
			prompt = input.Blocks
		} else {
			prompt = []any{O("type", "text", "text", input.Text)}
		}
		return O("sessionId", sessionID, "prompt", prompt)
	}, input, false)
}

// Compact：手动压缩上下文（扩展方法，如 Grok 的 `_x.ai/compact_conversation`，参数 {sessionId}）。
// 按一轮处理：期间的更新带这一轮的 id；自己补上「压缩中 / 清状态」，CLI 另发不发 auto_compact_* 都一样。
// 方法不存在等 RPC 错误照常 reject（*rpc.RpcError），由调用方决定退回什么。
func (d *AcpDriver) Compact(method string, input TurnInput) *jsrt.Promise[TurnResult] {
	return d.runTurn(method, func(sessionID string) Json { return O("sessionId", sessionID) }, input, true)
}

func (d *AcpDriver) runTurn(method string, params func(sessionID string) Json, input TurnInput, compacting bool) *jsrt.Promise[TurnResult] {
	return jsrt.Async(func() (TurnResult, error) {
		sessionID, err := d.requireSession()
		if err != nil {
			return nil, err
		}
		if d.turn != nil {
			return nil, errors.New("previous turn still running")
		}
		mk := d.o.Mapper
		if mk == nil {
			mk = NewAcpMapper
		}
		turn := &acpTurn{id: pick(d.o.NewID)(), mapper: mk()}
		d.turn = turn
		emit := func(ev Ev) {
			turn.text = clisdk.AppendText(turn.text, ev)
			d.hub.Emit(O("kind", "harness", "event", ev, "turnId", turn.id))
		}
		if compacting {
			emit(O("type", "status", "kind", "compact"))
		}
		defer func() {
			if compacting {
				emit(O("type", "status", "kind", "clear"))
			}
			if d.turn == turn {
				d.turn = nil
			}
		}()
		ms := AcpPromptIdleMs
		if d.o.PromptIdleMs != nil {
			ms = *d.o.PromptIdleMs
		}
		r, err := jsrt.Await(d.Conn.Request(method, params(sessionID), rpc.RequestOptions{
			Idle: true, TimeoutMs: &ms, Signal: input.Signal,
			OnTimeout: func() {
				d.Interrupt()
				if input.OnTimeout != nil {
					input.OnTimeout()
				}
			},
		}))
		if err != nil {
			return nil, err
		}
		for _, ev := range turn.mapper.Flush() {
			emit(ev)
		}
		ctx := turn.mapper.Context()
		var stop any = "end_turn"
		if v := getp(r, "stopReason"); v != nil {
			stop = v
		}
		res := O("turnId", turn.id, "stopReason", stop, "text", turn.text, "sessionId", sessionID)
		if ctx.Len() > 0 {
			res.Set("usage", ctx)
		}
		if turn.denied {
			res.Set("denied", true)
		}
		if _, u := r.(jsrt.UndefinedT); !u {
			res.Set("raw", r)
		}
		return res, nil
	})
}

// Steer：有扩展方法、有进行中的轮次和会话时发 {sessionId, text}；CLI 报错 = false。
func (d *AcpDriver) Steer(text string) *jsrt.Promise[bool] {
	method := d.o.SteerMethod
	if method == "" || d.turn == nil || d.sid == nil || *d.sid == "" {
		return jsrt.Resolved(false)
	}
	req := d.Conn.Request(method, O("sessionId", *d.sid, "text", text), rpc.RequestOptions{})
	return jsrt.Async(func() (bool, error) {
		_, err := jsrt.Await(req)
		return err == nil, nil
	})
}

func (d *AcpDriver) Interrupt() *jsrt.Promise[struct{}] {
	if d.sid != nil && *d.sid != "" {
		d.Conn.Notify("session/cancel", O("sessionId", *d.sid))
	}
	d.cancelPermissions()
	return jsrt.Resolved(struct{}{})
}

func (d *AcpDriver) Close() *jsrt.Promise[struct{}] {
	d.cancelPermissions()
	clisdk.EndChild(d.o.Child, d.o.Kill)
	return jsrt.Resolved(struct{}{})
}
