// Package sandbox 对应 packages/core/src/sandbox：CodeSandbox / platformSandbox / agentBrowserGuard。
package sandbox

import (
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

// RequestVerdict 是 agentBrowserGuard.RequestVerdict。
type RequestVerdict struct {
	Cancel bool   `json:"cancel"`
	Reason string `json:"reason,omitempty"`
}

// 不产生网络访问的内置 scheme
var localSchemes = map[string]bool{"about:": true, "data:": true, "blob:": true, "chrome-error:": true}

type parsedURL struct {
	protocol string // 含冒号，小写
	hostname string // WHATWG hostname
	rest     string // 冒号之后的部分（已清洗）
}

// parseURL 是无 base 的 `new URL(raw)` 中本模块用到的部分：protocol / hostname / 是否合法。
func parseURL(raw string) (*parsedURL, bool) {
	s := security.CleanURL(raw)
	if !security.ValidScheme(s) {
		return nil, false
	}
	colon := strings.Index(s, ":")
	scheme := strings.ToLower(s[:colon])
	p := &parsedURL{protocol: scheme + ":", rest: s[colon:]}
	if security.IsSpecialScheme(scheme) && scheme != "file" {
		u, err := gwnet.ParseURL("http" + s[colon:])
		if err != nil {
			return nil, false
		}
		p.hostname = security.WhatwgHostname(u)
	} else if scheme == "file" {
		if !security.FileHostValid(p.rest[1:]) {
			return nil, false
		}
	} else if !security.IsSpecialScheme(scheme) && strings.HasPrefix(p.rest, "://") {
		// 非特殊 scheme 的 opaque host：authority 去掉 userinfo / 端口，保留大小写
		auth := p.rest[3:]
		if i := strings.IndexAny(auth, "/?#"); i >= 0 {
			auth = auth[:i]
		}
		if i := strings.LastIndex(auth, "@"); i >= 0 {
			auth = auth[i+1:]
		}
		if i := strings.LastIndex(auth, ":"); i >= 0 && !strings.HasSuffix(auth, "]") {
			auth = auth[:i]
		}
		p.hostname = auth
	}
	return p, true
}

// toHttpEquivalent：ws→http、wss→https，其余原样
func (p *parsedURL) toHttpEquivalent() string {
	switch p.protocol {
	case "ws:":
		return "http" + p.rest
	case "wss:":
		return "https" + p.rest
	}
	return strings.TrimSuffix(p.protocol, ":") + p.rest
}

// CheckRequestUrlSync 是 checkRequestUrlSync。
func CheckRequestUrlSync(raw string) RequestVerdict {
	u, ok := parseURL(raw)
	if !ok {
		return RequestVerdict{Cancel: true, Reason: "invalid url"}
	}
	if localSchemes[u.protocol] {
		return RequestVerdict{}
	}
	switch u.protocol {
	case "http:", "https:", "ws:", "wss:":
	default:
		return RequestVerdict{Cancel: true, Reason: "blocked scheme " + u.protocol}
	}
	if _, err := security.AssertPublicHttpUrl(u.toHttpEquivalent()); err != nil {
		return RequestVerdict{Cancel: true, Reason: err.Error()}
	}
	return RequestVerdict{}
}

// RequestGuardOptions 是 RequestGuardOptions。
type RequestGuardOptions struct {
	LookupAll security.LookupAll
}

// RequestGuard 是 createRequestGuard 的返回值。
type RequestGuard struct {
	opts    RequestGuardOptions
	mu      sync.Mutex
	blocked []string // 插入序（Set 迭代序）
}

// NewRequestGuard 是 createRequestGuard。
func NewRequestGuard(opts RequestGuardOptions) *RequestGuard { return &RequestGuard{opts: opts} }

func (g *RequestGuard) has(h string) bool {
	for _, b := range g.blocked {
		if b == h {
			return true
		}
	}
	return false
}

// DecideRequest 是 decideRequest。
func (g *RequestGuard) DecideRequest(raw string) RequestVerdict {
	if v := CheckRequestUrlSync(raw); v.Cancel {
		return v
	}
	u, _ := parseURL(raw)
	if localSchemes[u.protocol] {
		return RequestVerdict{}
	}
	g.mu.Lock()
	blocked := g.has(strings.ToLower(u.hostname))
	g.mu.Unlock()
	if blocked {
		return RequestVerdict{Cancel: true, Reason: "host previously resolved to a private address"}
	}
	if _, err := security.AssertPublicHttpUrlResolved(u.toHttpEquivalent(), g.opts.LookupAll); err != nil {
		return RequestVerdict{Cancel: true, Reason: err.Error()}
	}
	return RequestVerdict{}
}

// OnConnected 是 onConnected：实际对端 IP 落在内网 → true（调用方停止加载）并拉黑主机名。
func (g *RequestGuard) OnConnected(rawURL, ip string) bool {
	if ip == "" || !gwnet.IsPrivateHost(ip) {
		return false
	}
	if u, ok := parseURL(rawURL); ok {
		h := strings.ToLower(u.hostname)
		g.mu.Lock()
		if !g.has(h) {
			g.blocked = append(g.blocked, h)
		}
		g.mu.Unlock()
	}
	return true
}

// BlockedHosts 返回已拉黑主机名（插入序）。
func (g *RequestGuard) BlockedHosts() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string{}, g.blocked...)
}
