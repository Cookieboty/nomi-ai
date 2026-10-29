// Package igtools：主进程 ig 工具注册表里非 MCP 的工具（Node 生产装配 1:1）。
//
//	ToolsBuiltinPlugin(enable: time_now / random / echo)
//	→ UserPreferenceMemoryPlugin(exposeAsTools) 的 createPreferenceTools
//	→ CompanionToolsPlugin(autoConfirm → dangerous:false)
//	→ DesktopToolsPlugin：kb.tools() → mem.tools() → delegate.tools() → ext.tools()
//
// 入参 JSON Schema 为 asSchema(zod).jsonSchema 原文（golden 逐字比对），校验用 aifacade 的 zod 等价实现。
// dangerous：Node 只有 companion 工具显式声明（false），其余都是 undefined → DangerousUnset。
package igtools

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const draft = `"$schema":"http://json-schema.org/draft-07/schema#",`

const (
	timeNowSchema   = `{` + draft + `"type":"object","properties":{"tz":{"type":"string","minLength":1,"maxLength":64}},"additionalProperties":false}`
	randomSchema    = `{` + draft + `"type":"object","properties":{"min":{"type":"number"},"max":{"type":"number"},"integer":{"type":"boolean"}},"required":["min","max"],"additionalProperties":false}`
	echoSchema      = `{` + draft + `"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":4096}},"required":["text"],"additionalProperties":false}`
	setPrefSchema   = `{` + draft + `"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":128},"value":{},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["path","value"],"additionalProperties":false}`
	getPrefSchema   = `{` + draft + `"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":128}},"required":["path"],"additionalProperties":false}`
	emptySchema     = `{` + draft + `"type":"object","properties":{},"additionalProperties":false}`
	emotionSchemaT  = `{` + draft + `"type":"object","properties":{"name":{"type":"string","enum":%E},"weight":{"type":"number","minimum":0,"maximum":1}},"required":["name"],"additionalProperties":false}`
	gestureSchemaT  = `{` + draft + `"type":"object","properties":{"name":{"type":"string","enum":%E}},"required":["name"],"additionalProperties":false}`
	memSearchSchema = `{` + draft + `"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":300,"description":%D}},"required":["query"],"additionalProperties":false}`
	memRememberT    = `{` + draft + `"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":200,"description":%D},"kind":{"default":"note","type":"string","enum":["identity","preference","goal","dislike","habit","note"]}},"required":["text"],"additionalProperties":false}`
	kbSearchSchema  = `{` + draft + `"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":500,"description":%D},"limit":{"default":6,"type":"integer","minimum":1,"maximum":12}},"required":["query"],"additionalProperties":false}`
	skillLoadT      = `{` + draft + `"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64,"description":%D}},"required":["name"],"additionalProperties":false}`
	skillReadT      = `{` + draft + `"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64},"path":{"type":"string","minLength":1,"maxLength":200,"description":%D}},"required":["name","path"],"additionalProperties":false}`
)

func schema(tpl string, kv ...string) *u.Obj {
	for j := 0; j+1 < len(kv); j += 2 {
		tpl = strings.ReplaceAll(tpl, kv[j], kv[j+1])
	}
	v, err := u.ParseString(tpl)
	if err != nil {
		panic(err)
	}
	return v.(*u.Obj)
}

func enumJSON(vals []string) string {
	a := make([]any, len(vals))
	for i, v := range vals {
		a[i] = v
	}
	return u.Stringify(a)
}

// ---- zod 校验（与 Node 各工具的 z.object(...).strict() 同形）----

type z = aifacade.Schema

func str(min, max int) *aifacade.StrS { s := aifacade.Str(); s.Min, s.Max = min, max; return s }

func num(min, max *float64, integer bool) *aifacade.NumS {
	n := aifacade.Num()
	n.Min, n.Max, n.Int = min, max, integer
	return n
}

func f(x float64) *float64 { return &x }

var (
	timeNowIn = aifacade.ObjOf('S', "tz", aifacade.Opt(str(1, 64)))
	randomIn  = aifacade.Refine(aifacade.ObjOf('S', "min", num(nil, nil, false), "max", num(nil, nil, false),
		"integer", aifacade.Opt(aifacade.Bool)), func(v any) bool {
		o := v.(*u.Obj)
		mx, _ := o.Get("max").(float64)
		mn, _ := o.Get("min").(float64)
		return mx >= mn
	}, "max must be >= min")
	echoIn    = aifacade.ObjOf('S', "text", str(1, 4096))
	setPrefIn = aifacade.ObjOf('S', "path", str(1, 128), "value", aifacade.Unknown,
		"confidence", aifacade.Opt(num(f(0), f(1), false)))
	getPrefIn = aifacade.ObjOf('S', "path", str(1, 128))
	gestureIn = aifacade.ObjOf('S', "name", aifacade.Enum(charcontract.SemanticGestures...))
	emotionIn = aifacade.ObjOf('S', "name", aifacade.Enum(charcontract.SemanticEmotions...),
		"weight", aifacade.Opt(num(f(0), f(1), false)))
	kbIn = aifacade.ObjOf('S', "query", str(1, 500),
		"limit", aifacade.Default(num(f(1), f(12), true), func() any { return float64(6) }))
	memSearchIn   = aifacade.ObjOf('S', "query", str(1, 300))
	memRememberIn = aifacade.ObjOf('S', "text", str(1, 200),
		"kind", aifacade.Default(aifacade.Enum("identity", "preference", "goal", "dislike", "habit", "note"), func() any { return "note" }))
	skillLoadIn = aifacade.ObjOf('S', "name", str(1, 64))
	skillReadIn = aifacade.ObjOf('S', "name", str(1, 64), "path", str(1, 200))
)

// parse = schema.parse(raw)：失败抛 ZodError（message = JSON.stringify(issues, null, 2)）
func parse(s z, in any) (*u.Obj, error) {
	out, iss, ok := aifacade.Parse(s, in)
	if !ok {
		return nil, aifacade.ZodError(iss)
	}
	return out.(*u.Obj), nil
}
