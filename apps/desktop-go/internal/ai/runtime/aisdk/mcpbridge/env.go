package mcpbridge

import (
	"log"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func nonEmpty(v string, ok bool) (string, bool) {
	if !ok || strings.TrimSpace(v) == "" {
		return "", false
	}
	return strings.TrimSpace(v), true
}

// Warnf：console.warn（测试可替换）
var Warnf = func(format string, args ...any) { log.Printf(format, args...) }

// ServersFromEnv：igPlugins.mcpServersFromEnv（MCP_SERVERS JSON 数组；非法 → []）
func ServersFromEnv(lookup func(string) (string, bool)) []ServerConfig {
	raw, ok := nonEmpty(lookup("MCP_SERVERS"))
	if !ok {
		return []ServerConfig{}
	}
	parsed, err := u.ParseString(raw)
	if err != nil {
		Warnf("[igPlugins] MCP_SERVERS JSON parse failed %v", err)
		return []ServerConfig{}
	}
	arr, isArr := parsed.([]any)
	if !isArr {
		Warnf("[igPlugins] MCP_SERVERS must be a JSON array")
		return []ServerConfig{}
	}
	out := []ServerConfig{}
	for _, item := range arr {
		o, ok := item.(*u.Obj)
		if !ok || o == nil {
			continue // 数组项（typeof 'object'）当对象读时各字段均为 undefined → id 为空被跳过
		}
		id := ""
		if s, ok := o.Get("id").(string); ok {
			id = strings.TrimSpace(s)
		}
		name := id
		if s, ok := o.Get("name").(string); ok {
			name = strings.TrimSpace(s)
		}
		transport, _ := o.Get("transport").(string)
		if id == "" || (transport != "http" && transport != "sse" && transport != "stdio" && transport != "websocket") {
			continue
		}
		if name == "" {
			name = id
		}
		c := ServerConfig{ID: id, Name: name, Transport: transport}
		if s, ok := o.Get("command").(string); ok {
			c.Command = s
		}
		if a, ok := o.Get("args").([]any); ok {
			c.Args = make([]string, len(a))
			for i, x := range a {
				if x == nil {
					c.Args[i] = "null"
				} else {
					c.Args[i] = jsString(x)
				}
			}
		}
		if s, ok := o.Get("url").(string); ok {
			c.URL = s
		}
		c.Env = recordPairs(o.Get("env"))
		c.Headers = recordPairs(o.Get("headers"))
		out = append(out, c)
	}
	return out
}

// recordPairs：o.env && typeof o.env === 'object' ? o.env : undefined（值在 spawn / Headers 处被 String()）
func recordPairs(v any) [][2]string {
	switch x := v.(type) {
	case *u.Obj:
		if x == nil {
			return nil
		}
		out := [][2]string{}
		for _, k := range x.Keys() {
			out = append(out, [2]string{k, jsString(x.Get(k))})
		}
		return out
	case []any:
		out := [][2]string{}
		for i, e := range x {
			out = append(out, [2]string{u.FormatNumber(float64(i)), jsString(e)})
		}
		return out
	}
	return nil
}

// AutoConnectFromEnv：mcpAutoConnectFromEnv
func AutoConnectFromEnv(lookup func(string) (string, bool)) bool {
	v, ok := nonEmpty(lookup("MCP_AUTO_CONNECT"))
	if !ok {
		return false
	}
	v = strings.ToLower(v)
	return v == "1" || v == "true" || v == "yes"
}
