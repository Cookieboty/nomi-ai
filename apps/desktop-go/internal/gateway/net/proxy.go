package net

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	gonet "net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	xproxy "golang.org/x/net/proxy"
)

// Proxy handling mirrors undici 7 EnvHttpProxyAgent + ProxyAgent exactly:
//   - http_proxy ?? HTTP_PROXY (lowercase wins; an empty value counts as set),
//     https_proxy ?? HTTPS_PROXY, falling back to the http proxy;
//   - ALL_PROXY is only a trigger in proxyEnvActive, never used as a proxy;
//   - no_proxy ?? NO_PROXY re-read on every request; `*`, `host`, `.host`,
//     `*.host`, `host:port`, split on comma / whitespace;
//   - every target (http and https) is tunnelled with CONNECT; socks5:// and
//     socks:// proxies are supported; Basic auth only when user and password.

type envFn func(string) (string, bool)

func coalesce(env envFn, keys ...string) string {
	for _, k := range keys {
		if v, ok := env(k); ok {
			return v
		}
	}
	return ""
}

type noProxyEntry struct {
	host string
	port int
}

var hostPortRe = regexp.MustCompile(`^(.+):(\d+)$`)
var leadDotRe = regexp.MustCompile(`^\*?\.`)
var splitRe = regexp.MustCompile(`[,\s]`)

func parseNoProxy(v string) []noProxyEntry {
	var out []noProxyEntry
	for _, e := range splitRe.Split(v, -1) {
		if e == "" {
			continue
		}
		h, p := e, 0
		if m := hostPortRe.FindStringSubmatch(e); m != nil {
			h = m[1]
			p, _ = strconv.Atoi(m[2])
		}
		out = append(out, noProxyEntry{strings.ToLower(leadDotRe.ReplaceAllString(h, "")), p})
	}
	return out
}

func shouldProxy(noProxy, hostname string, port int) bool {
	entries := parseNoProxy(noProxy)
	if len(entries) == 0 {
		return true
	}
	if noProxy == "*" {
		return false
	}
	for _, e := range entries {
		if e.port != 0 && e.port != port {
			continue
		}
		if hostname == e.host || strings.HasSuffix(hostname, "."+e.host) {
			return false
		}
	}
	return true
}

// envProxy is the proxy selection captured when the dispatcher is created.
type envProxy struct {
	env   envFn
	http  *url.URL
	https *url.URL
	err   error
}

func newEnvProxy(env envFn) *envProxy {
	if env == nil {
		env = os.LookupEnv
	}
	p := &envProxy{env: env}
	parse := func(s string) *url.URL {
		if s == "" {
			return nil
		}
		u, err := url.Parse(s)
		if err != nil || u.Host == "" {
			p.err = fmt.Errorf("invalid proxy url %q", s)
			return nil
		}
		return u
	}
	p.http = parse(coalesce(env, "http_proxy", "HTTP_PROXY"))
	p.https = parse(coalesce(env, "https_proxy", "HTTPS_PROXY"))
	if p.https == nil && p.err == nil {
		p.https = p.http
	}
	return p
}

// pick returns the proxy for a target (nil = direct). host is lowercase,
// IPv6 keeps its brackets (undici strips the port from url.host).
func (p *envProxy) pick(scheme, host string, port int) *url.URL {
	if !shouldProxy(coalesce(p.env, "no_proxy", "NO_PROXY"), strings.ToLower(host), port) {
		return nil
	}
	if scheme == "https" {
		return p.https
	}
	return p.http
}

func proxyAuth(u *url.URL) string {
	if u.User == nil {
		return ""
	}
	user := u.User.Username()
	pass, _ := u.User.Password()
	if user == "" || pass == "" {
		return ""
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func defaultPort(scheme string) string {
	if scheme == "https" {
		return "443"
	}
	return "80"
}

// dialViaProxy opens a tunnel to target (host:port) through proxy.
func dialViaProxy(ctx context.Context, d *gonet.Dialer, proxy *url.URL, target string) (gonet.Conn, error) {
	switch proxy.Scheme {
	case "socks5", "socks":
		var auth *xproxy.Auth
		if proxy.User != nil {
			pw, _ := proxy.User.Password()
			auth = &xproxy.Auth{User: proxy.User.Username(), Password: pw}
		}
		pp := proxy.Port()
		if pp == "" {
			pp = "1080"
		}
		s, err := xproxy.SOCKS5("tcp", gonet.JoinHostPort(proxy.Hostname(), pp), auth, d)
		if err != nil {
			return nil, err
		}
		return s.(xproxy.ContextDialer).DialContext(ctx, "tcp", target)
	}
	pp := proxy.Port()
	if pp == "" {
		pp = defaultPort(proxy.Scheme)
	}
	conn, err := d.DialContext(ctx, "tcp", gonet.JoinHostPort(proxy.Hostname(), pp))
	if err != nil {
		return nil, err
	}
	if proxy.Scheme == "https" {
		tc := tls.Client(conn, &tls.Config{ServerName: proxy.Hostname()})
		if err := tc.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		conn = tc
	}
	// header order exactly as undici writes it
	req := "CONNECT " + target + " HTTP/1.1\r\nhost: " + target + "\r\nconnection: close\r\n"
	if a := proxyAuth(proxy); a != "" {
		req += "proxy-authorization: " + a + "\r\n"
	}
	req += "proxy-connection: keep-alive\r\n\r\n"
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
		defer conn.SetDeadline(timeZero)
	}
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		conn.Close()
		return nil, err
	}
	if resp.StatusCode != 200 {
		conn.Close()
		return nil, errors.New("Proxy response (" + strconv.Itoa(resp.StatusCode) + ") !== 200 when HTTP Tunneling")
	}
	if br.Buffered() > 0 {
		return &bufConn{Conn: conn, r: br}, nil
	}
	return conn, nil
}

type bufConn struct {
	gonet.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) { return c.r.Read(p) }
