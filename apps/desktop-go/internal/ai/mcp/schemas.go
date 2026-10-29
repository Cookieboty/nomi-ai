package mcp

import (
	"math"
	"regexp"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// zod v4 子集：只实现 types.ts / json-rpc-message.ts 用到的构件，输出与 zod 解析结果逐键一致：
// 对象输出 = shape 键按声明顺序（缺省的 optional 键不出现）+ loose 模式下未知键按输入顺序。

// schema：absent = 输入为 undefined。返回 (输出, 输出是否为 undefined, ok)。
type schema func(v any, absent bool) (out any, outAbsent bool, ok bool)

type field struct {
	key string
	s   schema
}

type objMode int

const (
	strip objMode = iota
	loose
	strict
)

func isPlainObj(v any) bool { _, ok := v.(*u.Obj); return ok }

func zString() schema {
	return func(v any, absent bool) (any, bool, bool) {
		_, ok := v.(string)
		return v, false, !absent && ok
	}
}

func zBool() schema {
	return func(v any, absent bool) (any, bool, bool) {
		_, ok := v.(bool)
		return v, false, !absent && ok
	}
}

func zNumber() schema {
	return func(v any, absent bool) (any, bool, bool) {
		f, ok := v.(float64)
		return v, false, !absent && ok && !math.IsNaN(f) && !math.IsInf(f, 0)
	}
}

// z.number().int()：安全整数
func zInt() schema {
	return func(v any, absent bool) (any, bool, bool) {
		f, ok := v.(float64)
		return v, false, !absent && ok && f == math.Trunc(f) && math.Abs(f) <= 9007199254740991
	}
}

func zLiteral(lit string) schema {
	return func(v any, absent bool) (any, bool, bool) {
		s, ok := v.(string)
		return v, false, !absent && ok && s == lit
	}
}

// z.unknown()：任意值，undefined 原样
func zUnknown() schema {
	return func(v any, absent bool) (any, bool, bool) { return v, absent, true }
}

// z.unknown().nonoptional()
func zNonoptional(s schema) schema {
	return func(v any, absent bool) (any, bool, bool) {
		if absent {
			return nil, true, false
		}
		return s(v, absent)
	}
}

func zOptional(s schema) schema {
	return func(v any, absent bool) (any, bool, bool) {
		if absent {
			return nil, true, true
		}
		return s(v, absent)
	}
}

// .nullish()
func zNullish(s schema) schema {
	return func(v any, absent bool) (any, bool, bool) {
		if absent {
			return nil, true, true
		}
		if v == nil {
			return nil, false, true
		}
		return s(v, absent)
	}
}

// .default(d)（absent → d）
func zDefault(s schema, d any) schema {
	return func(v any, absent bool) (any, bool, bool) {
		if absent {
			return d, false, true
		}
		return s(v, absent)
	}
}

// z.never().optional()
func zNeverOptional() schema {
	return func(v any, absent bool) (any, bool, bool) { return nil, true, absent }
}

var base64Re = regexp.MustCompile(`^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$`)

// z.base64()
func zBase64() schema {
	return func(v any, absent bool) (any, bool, bool) {
		s, ok := v.(string)
		return v, false, !absent && ok && base64Re.MatchString(s)
	}
}

func zArray(el schema) schema {
	return func(v any, absent bool) (any, bool, bool) {
		arr, ok := v.([]any)
		if absent || !ok {
			return nil, false, false
		}
		out := make([]any, len(arr))
		for i, x := range arr {
			o, oa, ok := el(x, false)
			if !ok {
				return nil, false, false
			}
			if oa {
				o = nil // 数组里的 undefined：JSON 里不会出现
			}
			out[i] = o
		}
		return out, false, true
	}
}

func zObject(mode objMode, fields ...field) schema {
	known := map[string]bool{}
	for _, f := range fields {
		known[f.key] = true
	}
	return func(v any, absent bool) (any, bool, bool) {
		in, ok := v.(*u.Obj)
		if absent || !ok {
			return nil, false, false
		}
		out := u.NewObj()
		for _, f := range fields {
			has := in.Has(f.key)
			var x any
			if has {
				x = rawGet(in, f.key)
			}
			o, oa, ok := f.s(x, !has)
			if !ok {
				return nil, false, false
			}
			if !oa {
				out.Set(f.key, o)
			}
		}
		for _, k := range in.Keys() {
			if known[k] {
				continue
			}
			switch mode {
			case strict:
				return nil, false, false
			case loose:
				out.Set(k, rawGet(in, k))
			}
		}
		return out, false, true
	}
}

// rawGet：取键的原值（null 保留为 nil）
func rawGet(o *u.Obj, k string) any { return o.Get(k) }

// extend：base 的 shape 后接新字段；同名字段替换原位置（zod extend 语义）
func extend(base []field, more ...field) []field {
	out := append([]field(nil), base...)
	for _, m := range more {
		replaced := false
		for i := range out {
			if out[i].key == m.key {
				out[i] = m
				replaced = true
			}
		}
		if !replaced {
			out = append(out, m)
		}
	}
	return out
}

func zUnion(opts ...schema) schema {
	return func(v any, absent bool) (any, bool, bool) {
		for _, s := range opts {
			if o, oa, ok := s(v, absent); ok {
				return o, oa, true
			}
		}
		return nil, false, false
	}
}

// z.record(z.string(), z.unknown())：浅拷贝
func zRecordUnknown() schema {
	return func(v any, absent bool) (any, bool, bool) {
		in, ok := v.(*u.Obj)
		if absent || !ok {
			return nil, false, false
		}
		out := u.NewObj()
		for _, k := range in.Keys() {
			out.Set(k, rawGet(in, k))
		}
		return out, false, true
	}
}

// z.json()：string | number | boolean | null | json[] | record<string, json>（深拷贝）
func zJSON() schema {
	var j schema
	j = func(v any, absent bool) (any, bool, bool) {
		if absent {
			return nil, false, false
		}
		switch x := v.(type) {
		case nil, string, bool:
			return v, false, true
		case float64:
			return v, false, !math.IsNaN(x) && !math.IsInf(x, 0)
		case []any:
			return zArray(j)(v, false)
		case *u.Obj:
			out := u.NewObj()
			for _, k := range x.Keys() {
				o, _, ok := j(rawGet(x, k), false)
				if !ok {
					return nil, false, false
				}
				out.Set(k, o)
			}
			return out, false, true
		}
		return nil, false, false
	}
	return j
}

// refine
func zRefine(s schema, pred func(out any) bool) schema {
	return func(v any, absent bool) (any, bool, bool) {
		o, oa, ok := s(v, absent)
		if !ok || !pred(o) {
			return nil, false, false
		}
		return o, oa, true
	}
}

// ───────── types.ts ─────────

var (
	looseEmpty = zObject(loose)

	baseParamsFields = []field{{"_meta", zOptional(looseEmpty)}}
	baseParams       = zObject(loose, baseParamsFields...)
	resultFields     = extend(baseParamsFields, field{"resultType", zOptional(zString())})
	resultSchema     = zObject(loose, resultFields...)

	implementationSchema = zObject(loose,
		field{"name", zString()}, field{"version", zString()}, field{"title", zOptional(zString())})

	elicitationCapability = zObject(loose, field{"applyDefaults", zOptional(zBool())})

	serverCapabilities = zObject(loose,
		field{"events", zNullish(zObject(loose, field{"listChanged", zNullish(zBool())}))},
		field{"experimental", zOptional(looseEmpty)},
		field{"logging", zOptional(looseEmpty)},
		field{"completions", zOptional(looseEmpty)},
		field{"prompts", zOptional(zObject(loose, field{"listChanged", zOptional(zBool())}))},
		field{"resources", zOptional(zObject(loose, field{"subscribe", zOptional(zBool())}, field{"listChanged", zOptional(zBool())}))},
		field{"tools", zOptional(zObject(loose, field{"listChanged", zOptional(zBool())}))},
		field{"elicitation", zOptional(elicitationCapability)},
	)

	DiscoverResultSchema = zObject(loose, extend(resultFields,
		field{"supportedVersions", zArray(zString())},
		field{"capabilities", serverCapabilities},
		field{"instructions", zOptional(zString())},
		field{"ttlMs", zOptional(zNumber())},
		field{"cacheScope", zOptional(zUnion(zLiteral("public"), zLiteral("private")))},
	)...)

	InitializeResultSchema = zObject(loose, extend(resultFields,
		field{"protocolVersion", zString()},
		field{"capabilities", serverCapabilities},
		field{"serverInfo", implementationSchema},
		field{"instructions", zOptional(zString())},
	)...)

	paginatedResultFields = extend(resultFields, field{"nextCursor", zOptional(zString())})

	toolSchema = zObject(loose,
		field{"name", zString()},
		field{"title", zOptional(zString())},
		field{"description", zOptional(zString())},
		field{"inputSchema", zObject(loose, field{"type", zOptional(zUnknown())}, field{"properties", zOptional(looseEmpty)})},
		field{"outputSchema", zOptional(looseEmpty)},
		field{"annotations", zOptional(zObject(loose,
			field{"title", zOptional(zString())},
			field{"readOnlyHint", zOptional(zBool())},
			field{"destructiveHint", zOptional(zBool())},
			field{"idempotentHint", zOptional(zBool())},
			field{"openWorldHint", zOptional(zBool())},
		))},
		field{"_meta", zOptional(zRecordUnknown())},
	)

	ListToolsResultSchema = zObject(loose, extend(paginatedResultFields, field{"tools", zArray(toolSchema)})...)

	textContent  = zObject(loose, field{"type", zLiteral("text")}, field{"text", zString()})
	imageContent = zObject(loose, field{"type", zLiteral("image")}, field{"data", zBase64()}, field{"mimeType", zString()})

	resourceContentsFields = []field{
		{"uri", zString()}, {"name", zOptional(zString())}, {"title", zOptional(zString())}, {"mimeType", zOptional(zString())},
	}
	embeddedResource = zObject(loose,
		field{"type", zLiteral("resource")},
		field{"resource", zUnion(
			zObject(loose, extend(resourceContentsFields, field{"text", zString()})...),
			zObject(loose, extend(resourceContentsFields, field{"blob", zBase64()})...),
		)},
	)
	resourceLinkContent = zObject(loose,
		field{"type", zLiteral("resource_link")}, field{"uri", zString()}, field{"name", zString()},
		field{"description", zOptional(zString())}, field{"mimeType", zOptional(zString())})
	unknownContent = zRefine(zObject(loose, field{"type", zString()}), func(o any) bool {
		switch u.AsObj(o).Get("type") {
		case "text", "image", "resource", "resource_link":
			return false
		}
		return true
	})

	callToolWithContentFields = extend(resultFields,
		field{"content", zArray(zUnion(textContent, imageContent, embeddedResource, resourceLinkContent, unknownContent))},
		field{"structuredContent", zOptional(zUnknown())},
		field{"isError", zDefault(zBool(), false)}, // z.boolean().default(false).optional()：v4 optional 透传 default
	)
	callToolWithContent = zObject(loose, callToolWithContentFields...)

	callToolWithStructuredContent = func() schema {
		inner := zObject(loose, extend(resultFields,
			field{"content", zNeverOptional()},
			field{"structuredContent", zJSON()},
			field{"isError", zDefault(zBool(), false)}, // z.boolean().default(false).optional()：v4 optional 透传 default
		)...)
		return func(v any, absent bool) (any, bool, bool) {
			o, _, ok := inner(v, absent)
			if !ok {
				return nil, false, false
			}
			r := u.AsObj(o).Clone()
			r.Set("content", []any{u.NewObj("type", "text", "text", u.Stringify(r.Get("structuredContent")))})
			return callToolWithContent(r, false)
		}
	}()

	CallToolResultSchema = zUnion(
		callToolWithContent,
		callToolWithStructuredContent,
		zObject(loose, extend(resultFields, field{"toolResult", zNonoptional(zUnknown())})...),
	)
)

// ───────── json-rpc-message.ts ─────────

var (
	jsonrpcID = zUnion(zString(), zInt())

	jsonrpcRequest = zObject(strict,
		field{"jsonrpc", zLiteral("2.0")}, field{"id", jsonrpcID},
		field{"method", zString()}, field{"params", zOptional(baseParams)})
	jsonrpcNotification = zObject(strict,
		field{"jsonrpc", zLiteral("2.0")},
		field{"method", zString()}, field{"params", zOptional(baseParams)})
	jsonrpcResponse = zObject(strict,
		field{"jsonrpc", zLiteral("2.0")}, field{"id", jsonrpcID}, field{"result", resultSchema})
	jsonrpcError = zObject(strict,
		field{"jsonrpc", zLiteral("2.0")}, field{"id", zOptional(jsonrpcID)},
		field{"error", zObject(strip, field{"code", zInt()}, field{"message", zString()}, field{"data", zOptional(zUnknown())})})

	JSONRPCMessageSchema = zUnion(jsonrpcRequest, jsonrpcNotification, jsonrpcResponse, jsonrpcError)
)

// SchemaError：ZodError（message 无法逐字复刻 zod 的 issues JSON，见 D-B5-MCP-3）
type SchemaError struct{}

func (SchemaError) Error() string { return "Invalid input" }
func (SchemaError) Name() string  { return "ZodError" }

// Parse = schema.parse(v)
func parseWith(s schema, v any) (*u.Obj, error) {
	o, _, ok := s(v, false)
	if !ok {
		return nil, SchemaError{}
	}
	return u.AsObj(o), nil
}

// SafeParse：golden 语料用（ok + 输出）
func SafeParse(name string, v any) (any, bool) {
	s := map[string]schema{
		"JSONRPCMessage": JSONRPCMessageSchema, "Initialize": InitializeResultSchema, "Discover": DiscoverResultSchema,
		"ListTools": ListToolsResultSchema, "CallTool": CallToolResultSchema,
	}[name]
	o, _, ok := s(v, false)
	return o, ok
}
