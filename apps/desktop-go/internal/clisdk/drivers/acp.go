package drivers

import (
	"errors"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const AcpPromptIdleMs = 10 * 60_000

var _ = time.Millisecond

// AcpDriverOptions mirrors AcpDriverOptions。
type AcpDriverOptions struct {
	Child              clisdk.ChildLike
	PermissionIDPrefix *string
	PromptIdleMs       *int
	RPC                rpc.ConnectionOptions
	Kill               clisdk.KillFn
	Mapper             func() AcpMapper
	ClientCapabilities Json
	NewID              func() string
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

// AcpDriver mirrors AcpDriver。构造需持 jsrt 锁。
type AcpDriver struct {
	Conn              *rpc.Connection
	o                 AcpDriverOptions
	hub               *clisdk.EventHub
	turn              *acpTurn
	perms             map[string]*pendingPerm
	permOrder         []string
	sid               *string
	exited            bool
	ModeID            *string
	AgentCapabilities Json
}

func NewAcpDriver(o AcpDriverOptions) *AcpDriver {
	d := &AcpDriver{o: o, hub: clisdk.NewEventHub(), perms: map[string]*pendingPerm{}, AgentCapabilities: O()}
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
	if method != "session/update" {
		return
	}
	u, _ := params.Get("update").(*util.Obj)
	if u == nil {
		// (params.update ?? {})：非对象原始值读属性均为 undefined
		u = O()
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

func (d *AcpDriver) cancelPermissions() {
	for _, id := range append([]string{}, d.permOrder...) {
		if p := d.perms[id]; p != nil {
			p.p.Resolve(O("decision", "cancel"))
		}
	}
}

func sigOpts(s *jsrt.AbortSignal) rpc.RequestOptions {
	return rpc.RequestOptions{Signal: s}
}

func (d *AcpDriver) Start(o clisdk.StartOptions) *jsrt.Promise[StartResult] {
	return jsrt.Async(func() (StartResult, error) {
		opts := sigOpts(o.Signal)
		caps := d.o.ClientCapabilities
		if caps == nil {
			caps = O("fs", O("readTextFile", false, "writeTextFile", false))
		}
		initV, err := jsrt.Await(d.Conn.Request("initialize", O("protocolVersion", float64(1), "clientCapabilities", caps), opts))
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
		var sid *string
		var modeNow any
		resumed := false
		if o.ResumeID != nil && *o.ResumeID != "" {
			resumeID := *o.ResumeID
			r, err := jsrt.Await(d.Conn.Request("session/load", O("sessionId", resumeID, "cwd", o.Cwd, "mcpServers", mcp), opts))
			if err == nil {
				modeNow = getp(getp(r, "modes"), "currentModeId")
				resumed = true
				sid = &resumeID
			}
		}
		if sid == nil {
			r, err := jsrt.Await(d.Conn.Request("session/new", O("cwd", o.Cwd, "mcpServers", mcp), opts))
			if err != nil {
				return nil, err
			}
			// r?.sessionId ?? null：值按原样（类型声明为 string）
			if v := getp(r, "sessionId"); v != nil {
				if s, ok := v.(string); ok {
					sid = &s
				} else if util.Truthy(v) {
					s := util.JSString(v)
					sid = &s // 非字符串真值：Node 原样存入（此处转字符串，见 D-B7 注）
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
		defer func() {
			if d.turn == turn {
				d.turn = nil
			}
		}()
		var prompt any
		if input.Blocks != nil {
			prompt = input.Blocks
		} else {
			prompt = []any{O("type", "text", "text", input.Text)}
		}
		ms := AcpPromptIdleMs
		if d.o.PromptIdleMs != nil {
			ms = *d.o.PromptIdleMs
		}
		r, err := jsrt.Await(d.Conn.Request("session/prompt", O("sessionId", sessionID, "prompt", prompt), rpc.RequestOptions{
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
			turn.text = clisdk.AppendText(turn.text, ev)
			d.hub.Emit(O("kind", "harness", "event", ev, "turnId", turn.id))
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
