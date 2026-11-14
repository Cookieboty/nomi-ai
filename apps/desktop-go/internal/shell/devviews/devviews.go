// Package devviews：开发态视图热更新（apps/desktop-go/dev.mjs）。资产服务器把 /mascot/*、/chat/* 反向代理到
// 对应的 Vite 开发服务器（base 同为 /mascot/、/chat/），WebView 里照常是 wails:// 同源页面，HMR 由 Vite 客户端
// 直连 ws://127.0.0.1:<端口>。HTML 经 viewpage.Patch(dev) 改写（运行时 + 报错转发）。只在设置了 NOMI_DEV_VIEWS 时生效。
package devviews

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/viewpage"
)

const (
	// macOS 默认 kern.ipc.somaxconn 为 128；Wails 为每个资产请求单独起 goroutine，
	// 限制到单个 Vite 端口的并发连接并复用长连接，避免瞬时数百个 ESM 请求打满队列被 reset。
	maxConnsPerTarget = 32
	maxIdleConnsTotal = 64
	// Node http.Server 默认 Keep-Alive 为 5s，提前淘汰空闲连接避免复用半关闭连接
	idleConnTimeout = 2 * time.Second
	maxGetRetries   = 3
)

// Env：`mascot=http://127.0.0.1:6127,chat=http://127.0.0.1:6128`（键 = 页面路径的第一段）
const Env = "NOMI_DEV_VIEWS"

// Parse 解析 Env 的值；只接受本机回环的 http 地址
func Parse(v string) (map[string]*url.URL, error) {
	out := map[string]*url.URL{}
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, raw, ok := strings.Cut(part, "=")
		if !ok || name == "" || strings.Contains(name, "/") {
			return nil, fmt.Errorf("%s: bad entry %q", Env, part)
		}
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
			return nil, fmt.Errorf("%s: %q must be http://127.0.0.1:<port>", Env, raw)
		}
		out[name] = u
	}
	return out, nil
}

// Middleware：/<name>/… 转给对应的开发服务器，其余交给 next（嵌入的资产、网关、灵动岛页）
func Middleware(targets map[string]*url.URL) func(http.Handler) http.Handler {
	rt := newTransport(len(targets))
	proxies := map[string]http.Handler{}
	for name, u := range targets {
		proxies[name] = proxy(u, rt)
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seg, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
			if p, ok := proxies[seg]; ok {
				p.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func newTransport(targetCount int) http.RoundTripper {
	maxIdle := maxConnsPerTarget * targetCount
	if maxIdle < maxIdleConnsTotal {
		maxIdle = maxIdleConnsTotal
	}
	return &retryRoundTripper{
		base: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxConnsPerHost:       maxConnsPerTarget,
			MaxIdleConns:          maxIdle,
			MaxIdleConnsPerHost:   maxConnsPerTarget,
			IdleConnTimeout:       idleConnTimeout,
			ExpectContinueTimeout: time.Second,
		},
	}
}

type retryRoundTripper struct {
	base http.RoundTripper
}

func (t *retryRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		res, err := t.base.RoundTrip(req)
		if err == nil || attempt >= maxGetRetries || !canRetryRequest(req) || !isTransientConnErr(err) {
			return res, err
		}
		timer := time.NewTimer(time.Duration(15<<attempt) * time.Millisecond)
		select {
		case <-req.Context().Done():
			timer.Stop()
			return nil, req.Context().Err()
		case <-timer.C:
		}
	}
}

func canRetryRequest(req *http.Request) bool {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return false
	}
	return req.Body == nil || req.Body == http.NoBody
}

func isTransientConnErr(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF)
}

func proxy(target *url.URL, rt http.RoundTripper) http.Handler {
	return &httputil.ReverseProxy{
		Transport: rt,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Vite 按 Host 头校验 allowedHosts：用开发服务器自己的地址
			pr.Out.Host = target.Host
			// 要改写 HTML，不要压缩的响应
			pr.Out.Header.Del("Accept-Encoding")
		},
		ModifyResponse: func(res *http.Response) error {
			if !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
				return nil
			}
			body, err := io.ReadAll(res.Body)
			_ = res.Body.Close()
			if err != nil {
				return err
			}
			body = viewpage.Patch(body, true)
			res.Body = io.NopCloser(bytes.NewReader(body))
			res.ContentLength = int64(len(body))
			res.Header.Set("Content-Length", strconv.Itoa(len(body)))
			return nil
		},
	}
}
