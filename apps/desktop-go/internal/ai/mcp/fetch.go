package mcp

import (
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"

	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// PackageVersion = @ai-sdk/mcp VERSION（UA 后缀 ai-sdk/<VERSION>）
const PackageVersion = "2.0.73"

// DefaultRuntimeUA = getRuntimeEnvironmentUserAgent()（Electron 主进程 Node 24：navigator.userAgent 小写）。D-B5-MCP-1
const DefaultRuntimeUA = "node.js/24"

var headerNameRe = regexp.MustCompile("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")

// commonHeaders：{...headers, ...base, 'mcp-protocol-version'} → withUserAgentSuffix（normalizeHeaders 小写去重、
// new Headers 校验/去首尾空白、按名字排序输出）。
func buildHeaders(user, base [][2]string, protocolVersion string, extra [][2]string, ua string) ([][2]string, error) {
	var rec [][2]string
	for _, kv := range user {
		rec = setPair(rec, kv[0], kv[1])
	}
	for _, kv := range base {
		rec = setPair(rec, kv[0], kv[1])
	}
	rec = setPair(rec, "mcp-protocol-version", protocolVersion)
	for _, kv := range extra {
		rec = setPair(rec, kv[0], kv[1])
	}
	norm := map[string]string{}
	var order []string
	for _, kv := range rec {
		k := strings.ToLower(kv[0])
		if _, ok := norm[k]; !ok {
			order = append(order, k)
		}
		norm[k] = kv[1]
	}
	for _, k := range order {
		if !headerNameRe.MatchString(k) {
			return nil, typeError("Headers.append: \"" + k + "\" is an invalid header name.")
		}
		v := strings.Trim(norm[k], "\t\n\r ")
		if strings.ContainsAny(v, "\x00\r\n") {
			return nil, typeError("Headers.append: \"" + norm[k] + "\" is an invalid header value.")
		}
		norm[k] = v
	}
	parts := []string{}
	for _, p := range []string{norm["user-agent"], "ai-sdk/" + PackageVersion, ua} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	norm["user-agent"] = strings.Join(parts, " ")
	keys := make([]string, 0, len(norm))
	for k := range norm {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([][2]string, len(keys))
	for i, k := range keys {
		out[i] = [2]string{k, norm[k]}
	}
	return out, nil
}

type fetchResponse struct {
	Status     int
	StatusText string
	OK         bool
	Header     http.Header
	Body       io.ReadCloser // nil = null body
	signal     Signal
}

var errRedirect = errors.New("unexpected redirect")

var httpClient = &http.Client{
	Transport:     &http.Transport{Proxy: nil, DisableCompression: true, ForceAttemptHTTP2: false},
	CheckRedirect: func(*http.Request, []*http.Request) error { return errRedirect }, // redirect: 'error'
}

// doFetch = undici fetch（Electron 主进程 net 未接管：globalThis.fetch）
func doFetch(signal Signal, method, href string, headers [][2]string, body *string) (*fetchResponse, error) {
	return doFetchDispatched(signal, method, href, headers, body, nil)
}

// doFetchDispatched：dispatched 在请求已写上连接（或失败）时调用——对应 undici fetch() 同步发起：
// Node 里"发起即在途"，fire-and-forget 的 GET 先于随后同步发起的 POST 到达服务端。
func doFetchDispatched(signal Signal, method, href string, headers [][2]string, body *string, dispatched func()) (*fetchResponse, error) {
	if dispatched != nil {
		defer dispatched()
	}
	if err := throwIfAborted(signal); err != nil {
		return nil, err
	}
	ctx := signal
	if ctx == nil {
		ctx, _ = newController()
	}
	// 注意：不再以 WroteRequest 为"在途"信号。net/http 在上一个响应体读完后是异步把连接放回空闲池的，
	// GET 可能新拨连接而随后的 POST 复用刚空闲的旧连接，服务端先看到 POST（undici 下 GET 拿到空闲 socket，
	// 顺序确定）。改为等到响应头（或失败，defer）——服务端必已先处理 GET，到达顺序与 Node 一致（D-B5-MCP-10）。
	var rd io.Reader
	if body != nil {
		rd = strings.NewReader(*body)
	}
	req, err := http.NewRequestWithContext(ctx, method, href, rd)
	if err != nil {
		return nil, &JSError{Name: "TypeError", Message: "fetch failed", Cause: err}
	}
	req.Header = http.Header{}
	for _, kv := range headers {
		req.Header[kv[0]] = []string{kv[1]}
	}
	if body != nil && !headerHasCI(req.Header, "content-type") {
		req.Header["content-type"] = []string{"text/plain;charset=UTF-8"}
	}
	gnet.ApplyUndiciRequestDefaults(req)
	// net/http 仅按规范键 "User-Agent" 判断是否补 "Go-http-client/1.1"：把小写键挪过去（线上头名大小写不敏感，D-B5-MCP-4）
	if v, ok := req.Header["user-agent"]; ok {
		delete(req.Header, "user-agent")
		req.Header["User-Agent"] = v
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		if aborted(signal) {
			return nil, reason(signal)
		}
		return nil, &JSError{Name: "TypeError", Message: "fetch failed", Cause: err}
	}
	if err := gnet.DecodeUndiciResponse(method, resp); err != nil {
		resp.Body.Close()
		return nil, &JSError{Name: "TypeError", Message: "fetch failed", Cause: err}
	}
	st := resp.Status
	if i := strings.IndexByte(st, ' '); i >= 0 {
		st = st[i+1:]
	} else {
		st = ""
	}
	r := &fetchResponse{Status: resp.StatusCode, StatusText: st, OK: resp.StatusCode >= 200 && resp.StatusCode < 300, Header: resp.Header, signal: signal}
	if method == "HEAD" || nullBodyStatus(resp.StatusCode) {
		resp.Body.Close()
	} else {
		r.Body = resp.Body
	}
	return r, nil
}

func nullBodyStatus(s int) bool { return s == 101 || s == 204 || s == 205 || s == 304 }

func headerHasCI(h http.Header, k string) bool {
	for kk := range h {
		if strings.EqualFold(kk, k) {
			return true
		}
	}
	return false
}

// readErr：读 body 中途失败——已 abort 则为 signal.reason，否则 TypeError terminated。
func (r *fetchResponse) readErr(err error) error {
	if aborted(r.signal) {
		return reason(r.signal)
	}
	return &JSError{Name: "TypeError", Message: "terminated", Cause: err}
}

// text = response.text()（UTF-8 解码，去 BOM）
func (r *fetchResponse) text() (string, error) {
	if r.Body == nil {
		return "", nil
	}
	defer r.Body.Close()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return "", r.readErr(err)
	}
	s := decodeUTF8(b)
	return strings.TrimPrefix(s, "\uFEFF"), nil
}

func (r *fetchResponse) discard() {
	if r.Body != nil {
		r.Body.Close()
	}
}

func decodeUTF8(b []byte) string {
	return nodeproc.DecodeChunk(b)
}
