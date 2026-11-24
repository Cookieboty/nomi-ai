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
	// DisableElicitation：不向 ACP 对端广告 form elicitation（托管只读运行时不支持交互弹窗）。
	DisableElicitation bool
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

func parseAvailableModeIDs(modes any) []string {
	arr, ok := getp(modes, "availableModes").([]any)
	if !ok || len(arr) == 0 {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, x := range arr {
		id, ok := getp(x, "id").(string)
		if !ok || id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
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
	AvailableModes    []string
	AgentCapabilities Json
	SessionRaw        Json
	SessionTitle      string
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
	if !ext {
		switch u.Get("sessionUpdate") {
		case "current_mode_update":
			mid := strQ(u.Get("currentModeId"))
			if mid == "" {
				mid = strQ(u.Get("modeId"))
			}
			if mid != "" {
				m := mid
				d.ModeID = &m
			}
		case "config_option_update", "config_options_update":
			if opts := u.Get("configOptions"); opts != nil {
				if d.SessionRaw == nil {
					d.SessionRaw = O()
				}
				d.SessionRaw.Set("configOptions", opts)
			}
		case "session_info_update":
			if title, ok := u.Get("title").(string); ok {
				if trimmed := strings.TrimSpace(title); trimmed != "" {
					d.SessionTitle = trimmed
				}
			}
		}
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
// 调用方已经给了非空的 elicitation 对象时保留，不覆盖；disableElicitation 为 true 时跳过注入。
func acpClientCaps(caps Json, disableElicitation bool) Json {
	if caps == nil {
		caps = O("fs", O("readTextFile", false, "writeTextFile", false))
	}
	if disableElicitation {
		return caps
	}
	if elic, ok := caps.Get("elicitation").(*util.Obj); ok && elic != nil {
		return caps
	}
	next := caps.Clone()
	next.Set("elicitation", O("form", O()))
	return next
}

func (d *AcpDriver) withSessionDirs(params *util.Obj, extraDirs []string) *util.Obj {
	if len(extraDirs) == 0 {
		return params
	}
	sc, _ := d.AgentCapabilities.Get("sessionCapabilities").(*util.Obj)
	if sc == nil || !util.Truthy(sc.Get("additionalDirectories")) {
		return params
	}
	dirs := make([]any, len(extraDirs))
	for i, x := range extraDirs {
		dirs[i] = x
	}
	return params.Set("additionalDirectories", dirs)
}

func (d *AcpDriver) finishSession(sid string, modes any, resumed, hadResume bool, pv any) StartResult {
	s := sid
	d.sid = &s
	d.AvailableModes = parseAvailableModeIDs(modes)
	modeNow := getp(modes, "currentModeId")
	if m, ok := modeNow.(string); ok {
		d.ModeID = &m
	}
	if d.SessionRaw != nil {
		if title, ok := d.SessionRaw.Get("title").(string); ok {
			if trimmed := strings.TrimSpace(title); trimmed != "" {
				d.SessionTitle = trimmed
			}
		}
	}
	d.hub.Emit(O("kind", "health", "state", "ready"))
	res := O("sessionId", sid)
	if hadResume {
		res.Set("resumed", resumed)
	}
	if m, ok := modeNow.(string); ok {
		res.Set("currentModeId", m)
	}
	if ver, ok := pv.(float64); ok {
		res.Set("version", util.FormatNumber(ver))
	}
	prompt := d.AgentCapabilities.Get("promptCapabilities")
	res.Set("capabilities", O(
		"loadSession", d.AgentCapabilities.Get("loadSession") == true,
		"images", getp(prompt, "image") == true,
		"audio", getp(prompt, "audio") == true,
	))
	return res
}

func parseReturnedSessionID(r any) string {
	v := getp(r, "sessionId")
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if util.Truthy(v) {
		return util.JSString(v)
	}
	return ""
}

// Initialize：仅发送 initialize 握手并保存对端 agentCapabilities。
func (d *AcpDriver) Initialize(signal *jsrt.AbortSignal) *jsrt.Promise[Json] {
	return jsrt.Async(func() (Json, error) {
		initV, err := jsrt.Await(d.Conn.Request("initialize", O("protocolVersion", float64(1), "clientCapabilities", acpClientCaps(d.o.ClientCapabilities, d.o.DisableElicitation)), sigOpts(signal)))
		if err != nil {
			return nil, err
		}
		if ac, ok := getp(initV, "agentCapabilities").(*util.Obj); ok {
			d.AgentCapabilities = ac
		} else {
			d.AgentCapabilities = O()
		}
		res := O()
		if obj, ok := initV.(*util.Obj); ok {
			res = obj
		}
		return res, nil
	})
}

// LoadSession：仅发送 session/load（不静默退回 session/new）。
func (d *AcpDriver) LoadSession(sessionID, cwd string, mcp any, extraDirs []string, signal *jsrt.AbortSignal) *jsrt.Promise[StartResult] {
	return jsrt.Async(func() (StartResult, error) {
		if sessionID == "" {
			return nil, errors.New("ACP session/load requires sessionId")
		}
		if mcp == nil {
			mcp = []any{}
		}
		r, err := jsrt.Await(d.Conn.Request("session/load", d.withSessionDirs(O("sessionId", sessionID, "cwd", cwd, "mcpServers", mcp), extraDirs), sigOpts(signal)))
		if err != nil {
			return nil, err
		}
		if ret := parseReturnedSessionID(r); ret != "" && ret != sessionID {
			return nil, errors.New("ACP session/load returned mismatched sessionId")
		}
		d.SessionRaw = util.AsObj(r)
		return d.finishSession(sessionID, getp(r, "modes"), true, true, nil), nil
	})
}

// NewSession：仅发送 session/new。
func (d *AcpDriver) NewSession(cwd string, mcp any, extraDirs []string, signal *jsrt.AbortSignal) *jsrt.Promise[StartResult] {
	return jsrt.Async(func() (StartResult, error) {
		if mcp == nil {
			mcp = []any{}
		}
		r, err := jsrt.Await(d.Conn.Request("session/new", d.withSessionDirs(O("cwd", cwd, "mcpServers", mcp), extraDirs), sigOpts(signal)))
		if err != nil {
			return nil, err
		}
		sid := parseReturnedSessionID(r)
		if sid == "" {
			return nil, errors.New("ACP agent returned no session")
		}
		d.SessionRaw = util.AsObj(r)
		return d.finishSession(sid, getp(r, "modes"), false, true, nil), nil
	})
}

func (d *AcpDriver) Start(o clisdk.StartOptions) *jsrt.Promise[StartResult] {
	return jsrt.Async(func() (StartResult, error) {
		opts := sigOpts(o.Signal)
		initV, err := jsrt.Await(d.Initialize(o.Signal))
		if err != nil {
			return nil, err
		}
		var mcp any = []any{}
		if o.McpServers != nil {
			mcp = o.McpServers
		}
		var sid string
		var modes any
		resumed := false
		hadResume := o.ResumeID != nil && *o.ResumeID != ""
		if hadResume {
			resumeID := *o.ResumeID
			r, err := jsrt.Await(d.Conn.Request("session/load", d.withSessionDirs(O("sessionId", resumeID, "cwd", o.Cwd, "mcpServers", mcp), o.AdditionalDirectories), opts))
			if err == nil {
				modes = getp(r, "modes")
				d.SessionRaw = util.AsObj(r)
				resumed = true
				sid = resumeID
			}
		}
		if sid == "" {
			r, err := jsrt.Await(d.Conn.Request("session/new", d.withSessionDirs(O("cwd", o.Cwd, "mcpServers", mcp), o.AdditionalDirectories), opts))
			if err != nil {
				return nil, err
			}
			sid = parseReturnedSessionID(r)
			modes = getp(r, "modes")
			d.SessionRaw = util.AsObj(r)
		}
		if sid == "" {
			return nil, errors.New("ACP agent returned no session")
		}
		var pv any
		if initV != nil {
			pv = initV.Get("protocolVersion")
		}
		return d.finishSession(sid, modes, resumed, hadResume, pv), nil
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
		merged := extractAcpPromptUsage(r)
		ctx := turn.mapper.Context()
		if ctx != nil && ctx.Len() > 0 {
			if merged == nil {
				merged = O()
			}
			merged.Assign(ctx)
		}
		var stop any = "end_turn"
		if v := getp(r, "stopReason"); v != nil {
			stop = v
		}
		res := O("turnId", turn.id, "stopReason", stop, "text", turn.text, "sessionId", sessionID)
		if merged != nil && merged.Len() > 0 {
			res.Set("usage", merged)
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

func pickNonNeg(u *util.Obj, keys ...string) (float64, bool) {
	for _, k := range keys {
		if f, ok := nonNegNum(u.Get(k)); ok {
			return f, true
		}
	}
	return 0, false
}

func extractAcpPromptUsage(r any) *util.Obj {
	u := util.AsObj(getp(r, "usage"))
	if u == nil {
		return nil
	}
	out := O()
	if v, ok := pickNonNeg(u, "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"); ok {
		out.Set("inputTokens", v)
	}
	if v, ok := pickNonNeg(u, "outputTokens", "output_tokens", "completionTokens", "completion_tokens"); ok {
		out.Set("outputTokens", v)
	}
	if v, ok := pickNonNeg(u, "cachedReadTokens", "cacheReadTokens", "cachedInputTokens", "cache_read_input_tokens", "cached_input_tokens", "cached_read_tokens"); ok {
		out.Set("cacheReadTokens", v)
	}
	if v, ok := pickNonNeg(u, "cachedWriteTokens", "cacheWriteTokens", "cache_creation_input_tokens", "cache_write_tokens", "cached_write_tokens"); ok {
		out.Set("cacheWriteTokens", v)
	}
	if v, ok := pickNonNeg(u, "thoughtTokens", "thought_tokens", "reasoningTokens", "reasoning_tokens"); ok {
		out.Set("thoughtTokens", v)
	}
	if v, ok := pickNonNeg(u, "totalTokens", "total_tokens"); ok {
		out.Set("totalTokens", v)
	}
	if v, ok := nonNegNum(u.Get("costUsd")); ok {
		out.Set("costUsd", v)
	} else if c := util.AsObj(u.Get("cost")); c != nil {
		if v, ok := nonNegNum(c.Get("amount")); ok {
			cur := strings.TrimSpace(strQ(c.Get("currency")))
			if cur == "" || strings.EqualFold(cur, "USD") {
				out.Set("costUsd", v)
			}
		}
	}
	if out.Len() == 0 {
		return nil
	}
	return out
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
