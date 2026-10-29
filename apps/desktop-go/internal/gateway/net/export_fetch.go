package net

import "net/http"

// ApplyUndiciRequestDefaults：undici fetch 补的默认请求头（accept / accept-language / sec-fetch-mode /
// user-agent 仅缺失时补，大小写不敏感判断，按小写名写入）+ accept-encoding 规则。供 internal/ai/mcp 复用。
func ApplyUndiciRequestDefaults(req *http.Request) {
	for _, kv := range [][2]string{{"accept", "*/*"}, {"accept-language", "*"}, {"sec-fetch-mode", "cors"}, {"user-agent", "undici"}} {
		if !headerHas(req.Header, kv[0]) {
			req.Header[kv[0]] = []string{kv[1]}
		}
	}
	acceptEncodingDefaults(req)
}

// DecodeUndiciResponse：按 undici 规则解码 content-encoding（见 decodeResponse）。
func DecodeUndiciResponse(method string, resp *http.Response) error {
	return decodeResponse(method, resp)
}
