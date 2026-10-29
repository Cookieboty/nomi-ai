package aifacade

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 插件事件总线（ig ctx.emit / ctx.on）在门面这一侧的对应：
//   - AIClient.bindRuntimeBridges：插件事件 → AIClientEvent → AiContractRouter.bindEvents（AI_EVENTS）→ 契约事件；
//   - ToolsFacade.confirm：ctx.emit('tools/wrap', { reqId, ok, reason })。
// Node 生产装配里没有插件发 agent/turn-end、agent/stopped-by-user、tool/confirm-required、
// tools/post-execute（GuardrailsPlugin 未装配，tools/wrap 也无人监听），agent:step 根本没有桥；
// Go 侧照搬同一张桥表，谁 Hook 了就按 Node 同样的映射与事件 schema 推出去。

// bridges：AIClient.ts bindRuntimeBridges 的映射表（插件事件 → 契约事件）
var bridges = map[string]string{
	"session/assistant-message": "ai.message.complete",
	"agent/turn-end":            "ai.agent.turnEnd",
	"agent/stopped-by-user":     "ai.agent.stoppedByUser",
	"tool/confirm-required":     "ai.tool.confirmRequired",
	"tools/post-execute":        "ai.tool.executed",
	"tts/chunk":                 "ai.tts.chunk",
	"tts/end":                   "ai.tts.end",
	"userProfile/changed":       "ai.userProfile.changed",
}

// 契约 aiEvents：loose(shape) = looseObject(shape).partial()——必须是对象，已知字段可缺省、有则类型对，未知字段透传
const (
	evStr = iota
	evNum
	evBool
	evAny
	evBytes
	evStrs
)

// 字段按 schema 声明序（zod 解析输出：已知字段按 shape 序，未知字段随后按原序）
type evField struct {
	k    string
	kind int
}

var eventShapes = map[string][]evField{
	"ai.message.delta":        {{"sessionId", evStr}, {"messageId", evStr}, {"deltaText", evStr}, {"part", evAny}},
	"ai.message.complete":     {{"message", evAny}},
	"ai.agent.step":           {{"sessionId", evStr}, {"step", evNum}, {"reason", evStr}},
	"ai.agent.turnEnd":        {{"sessionId", evStr}, {"turnId", evStr}, {"ok", evBool}, {"reason", evStr}},
	"ai.agent.stoppedByUser":  {{"sessionId", evStr}, {"reqId", evStr}},
	"ai.tool.confirmRequired": {{"reqId", evStr}, {"toolName", evStr}, {"argumentsJson", evStr}, {"reason", evStr}, {"createdAt", evNum}},
	"ai.tool.executed":        {{"toolName", evStr}, {"reqId", evStr}, {"ok", evBool}, {"durationMs", evNum}, {"error", evStr}},
	"ai.tts.chunk":            {{"reqId", evStr}, {"seq", evNum}, {"mime", evStr}, {"data", evBytes}, {"rms", evNum}, {"atMs", evNum}, {"isFinal", evBool}},
	"ai.tts.end":              {{"reqId", evStr}, {"ok", evBool}, {"durationMs", evNum}},
	"ai.userProfile.changed":  {{"profile", evAny}},
	"ai.avatar.touched":       {{"hitbox", evStr}, {"at", evNum}},
	"ai.avatar.clicked":       {{"hitbox", evStr}, {"double", evBool}, {"at", evNum}},
	"ai.avatar.scene":         {{"characterId", evStr}, {"emotions", evStrs}, {"activities", evStrs}, {"gestures", evStrs}, {"at", evNum}},
}

func evFieldOK(kind int, v any) bool {
	switch kind {
	case evStr:
		_, ok := v.(string)
		return ok
	case evNum:
		_, ok := v.(float64)
		return ok
	case evBool:
		_, ok := v.(bool)
		return ok
	case evBytes:
		if _, ok := v.(contract.Bytes); ok {
			return true
		}
		return IsBytes(v)
	case evStrs:
		a, ok := v.([]any)
		if !ok {
			return false
		}
		for _, x := range a {
			if _, ok := x.(string); !ok {
				return false
			}
		}
		return true
	}
	return true
}

// parseEvent：router.ts events.publish 的 schema 校验与解析结果（失败 = BAD_OUTPUT，bindEvents 记 warn 后丢弃）
func parseEvent(event string, data any) (*u.Obj, bool) {
	shape, ok := eventShapes[event]
	if !ok {
		return nil, false
	}
	o, ok := data.(*u.Obj)
	if !ok {
		return nil, false
	}
	out := u.NewObj()
	known := map[string]bool{}
	for _, f := range shape {
		known[f.k] = true
		if !o.Has(f.k) {
			continue
		}
		if !evFieldOK(f.kind, o.Get(f.k)) {
			return nil, false
		}
		out.Set(f.k, o.Get(f.k))
	}
	for _, k := range o.Keys() {
		if !known[k] {
			out.Set(k, o.Get(k))
		}
	}
	return out, true
}

// On 订阅插件事件（ctx.on）；返回退订
func (f *Facade) On(event string, fn func(payload any)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hooks == nil {
		f.hooks = map[string][]*func(any){}
	}
	p := &fn
	f.hooks[event] = append(f.hooks[event], p)
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		l := f.hooks[event]
		for i, x := range l {
			if x == p {
				f.hooks[event] = append(l[:i:i], l[i+1:]...)
				return
			}
		}
	}
}

// Hook 发插件事件（ctx.emit）：先给订阅者，再按 AIClient 桥表转成契约事件（校验不过则丢弃）
func (f *Facade) Hook(event string, payload any) {
	f.mu.Lock()
	ls := append([]*func(any){}, f.hooks[event]...)
	f.mu.Unlock()
	for _, fn := range ls {
		(*fn)(payload)
	}
	ev, ok := bridges[event]
	if !ok {
		return
	}
	if event == "session/assistant-message" {
		o, _ := payload.(*u.Obj)
		if o == nil || !truthy(o.Get("message")) {
			return
		}
	}
	if d, ok := parseEvent(ev, payload); ok {
		f.o.Emit(ev, d)
	}
}
