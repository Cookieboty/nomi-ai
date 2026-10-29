package mcp

import (
	"regexp"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Message = JSONRPCMessage（zod 解析后的有序对象）
type Message = *u.Obj

var (
	suspectProtoRx       = regexp.MustCompile(`"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:`)
	suspectConstructorRx = regexp.MustCompile(`"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:`)
)

// JSONParseError（@ai-sdk/provider）；cause 的 V8 文案不可复刻（D-B5-MCP-3）
type JSONParseError struct {
	Text  string
	Cause error
}

func (e *JSONParseError) Error() string {
	return "JSON parsing failed: Text: " + e.Text + ".\nError message: " + e.Cause.Error()
}
func (e *JSONParseError) Unwrap() error { return e.Cause }
func (e *JSONParseError) Name() string  { return "AI_JSONParseError" }

// secureJSONParse = provider-utils secureJsonParse
func secureJSONParse(text string) (any, error) {
	v, err := u.ParseString(text)
	if err != nil {
		return nil, syntaxError(err.Error())
	}
	if !isPlainObj(v) && !u.IsArr(v) {
		return v, nil
	}
	if !suspectProtoRx.MatchString(text) && !suspectConstructorRx.MatchString(text) {
		return v, nil
	}
	next := []any{v}
	for len(next) > 0 {
		nodes := next
		next = nil
		for _, n := range nodes {
			var vals []any
			switch x := n.(type) {
			case *u.Obj:
				if x.Has("__proto__") {
					return nil, syntaxError("Object contains forbidden prototype property")
				}
				if c, ok := x.Get("constructor").(*u.Obj); ok && x.Has("constructor") && c.Has("prototype") {
					return nil, syntaxError("Object contains forbidden prototype property")
				}
				for _, k := range x.Keys() {
					vals = append(vals, x.Get(k))
				}
			case []any:
				vals = x
			}
			for _, val := range vals {
				switch val.(type) {
				case *u.Obj, []any:
					next = append(next, val)
				}
			}
		}
	}
	return v, nil
}

// parseJSON = provider-utils parseJSON({text})
func parseJSON(text string) (any, error) {
	v, err := secureJSONParse(text)
	if err != nil {
		return nil, &JSONParseError{Text: text, Cause: err}
	}
	return v, nil
}

// ValidateJSONRPCMessage = JSONRPCMessageSchema.parse
func ValidateJSONRPCMessage(v any) (Message, error) { return parseWith(JSONRPCMessageSchema, v) }

// ParseJSONRPCMessage = parseJSONRPCMessage(text)
func ParseJSONRPCMessage(text string) (Message, error) {
	v, err := parseJSON(text)
	if err != nil {
		return nil, err
	}
	return ValidateJSONRPCMessage(v)
}

// 消息分类（mcp-client.ts onmessage 的 'method' in / 'result' in / 'error' in 判断）
func hasKey(m Message, k string) bool { return m != nil && m.Has(k) }
