package mcp

import (
	"encoding/base64"
	"math"
	"regexp"
	"strconv"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// mcp-http-headers.ts

type headerBinding struct {
	headerName string
	path       []string
	valueType  string // boolean | integer | string
}

var (
	httpTokenPattern      = regexp.MustCompile("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")
	base64SentinelPattern = regexp.MustCompile(`(?s)^=\?base64\?.*\?=$`)
)

// isRecord：非 null、非数组对象
func isRecord(v any) bool { return isPlainObj(v) }

// EncodeMCPHeaderValue = encodeMCPHeaderValue
func EncodeMCPHeaderValue(value string) string {
	plain := true
	for _, r := range value {
		if !(r == 0x09 || (r >= 0x20 && r <= 0x7e)) {
			plain = false
			break
		}
	}
	// JS 的 . 不匹配行终止符；plain ASCII 只可能含 \t，(?s) 无影响
	if plain && u.JSTrim(value) == value && !base64SentinelPattern.MatchString(value) {
		return value
	}
	return "=?base64?" + base64.StdEncoding.EncodeToString([]byte(u.ToWellFormed(value))) + "?="
}

// getMCPToolHeaderBindings：返回 (bindings, errMsg)；errMsg != "" = 失败
func getMCPToolHeaderBindings(inputSchema any) ([]headerBinding, string) {
	if !isRecord(inputSchema) {
		return nil, "inputSchema must be a JSON Schema object"
	}
	bindings := []headerBinding{}
	names := map[string]bool{}
	errMsg := ""
	var visit func(v any, path []string, reachable bool)
	visit = func(v any, path []string, reachable bool) {
		if errMsg != "" || !isRecord(v) {
			return
		}
		o := v.(*u.Obj)
		if o.Has("x-mcp-header") {
			if !reachable || len(path) == 0 {
				errMsg = "x-mcp-header is not on a statically reachable property"
				return
			}
			hn, ok := o.Get("x-mcp-header").(string)
			if !ok || !httpTokenPattern.MatchString(hn) {
				errMsg = "x-mcp-header must be a non-empty HTTP token"
				return
			}
			norm := strings.ToLower(hn)
			if names[norm] {
				errMsg = `x-mcp-header value "` + hn + `" is not unique`
				return
			}
			vt, _ := o.Get("type").(string)
			if vt != "boolean" && vt != "integer" && vt != "string" {
				errMsg = "x-mcp-header can only annotate boolean, integer, or string properties"
				return
			}
			names[norm] = true
			bindings = append(bindings, headerBinding{headerName: hn, path: path, valueType: vt})
		}
		for _, k := range o.Keys() {
			if k == "x-mcp-header" {
				continue
			}
			child := o.Get(k)
			if k == "properties" && isRecord(child) {
				co := child.(*u.Obj)
				for _, pn := range co.Keys() {
					np := append(append([]string(nil), path...), pn)
					visit(co.Get(pn), np, reachable)
				}
			} else {
				visit(child, path, false)
			}
		}
	}
	visit(inputSchema, []string{}, true)
	if errMsg != "" {
		return nil, errMsg
	}
	return bindings, ""
}

func valueAtPath(v any, path []string) (any, bool) {
	cur := v
	for _, seg := range path {
		o, ok := cur.(*u.Obj)
		if !ok {
			return nil, false
		}
		if !o.Has(seg) {
			return nil, false
		}
		cur = o.Get(seg)
	}
	return cur, true
}

// createMCPToolHeaders；返回有序 [name, value] 对
func createMCPToolHeaders(bindings []headerBinding, args *u.Obj) ([][2]string, error) {
	out := [][2]string{}
	for _, b := range bindings {
		v, ok := valueAtPath(args, b.path)
		if !ok || v == nil {
			continue
		}
		var s string
		bad := false
		switch b.valueType {
		case "string":
			// 双值断言：模型把字符串参数给成数字 / 布尔时返回下面的类型错误，不能在这里 panic（#202）
			str, iss := v.(string)
			s, bad = str, !iss
		case "boolean":
			bv, isb := v.(bool)
			bad = !isb
			s = strconv.FormatBool(bv)
		case "integer":
			f, isn := v.(float64)
			bad = !isn || f != math.Trunc(f) || math.Abs(f) > 9007199254740991
			s = u.FormatNumber(f)
		}
		if bad {
			return nil, typeError(`Tool argument "` + strings.Join(b.path, ".") + `" does not match its x-mcp-header type`)
		}
		out = setPair(out, "Mcp-Param-"+b.headerName, EncodeMCPHeaderValue(s))
	}
	return out, nil
}

// setPair：Record 赋值（同键覆盖原位置）
func setPair(h [][2]string, k, v string) [][2]string {
	for i := range h {
		if h[i][0] == k {
			h[i][1] = v
			return h
		}
	}
	return append(h, [2]string{k, v})
}
