package net

import (
	"context"
	"crypto/tls"
	"errors"
	gonet "net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// Timeouts / pool sizes from upstreamFetch.ts.
const (
	ConnectTimeout   = 10 * time.Second
	HeadersTimeout   = 60 * time.Second
	KeepAliveTimeout = 30 * time.Second
	MaxConnsPerHost  = 32
)

type pinKey struct{}
type targetKey struct{}

type target struct {
	scheme, host string
	port         int
}

type pin struct {
	host  string
	addrs []LookupAddress
}

var timeZero time.Time

// ProxyEnvActive is proxyEnvActive (ALL_PROXY only switches to the env proxy
// agent, which itself never reads it).
func ProxyEnvActive(env func(string) (string, bool)) bool {
	if env == nil {
		env = os.LookupEnv
	}
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		if v, _ := env(k); v != "" {
			return true
		}
	}
	return false
}

// FetchOptions is CreateUpstreamFetchOptions.
type FetchOptions struct {
	GetGuard       func() GuardOpts
	ConnectTimeout time.Duration
	HeadersTimeout time.Duration
	// Env overrides os.LookupEnv (tests).
	Env func(string) (string, bool)
}

// UpstreamFetch sends req after validating its URL, dialing only the
// addresses validated for this request (no second DNS lookup, no redirects).
type UpstreamFetch func(req *http.Request) (*http.Response, error)

// NewTransport is createUpstreamDispatcher.
func NewTransport(o FetchOptions) *http.Transport {
	getGuard := o.GetGuard
	if getGuard == nil {
		getGuard = func() GuardOpts { return GuardOpts{} }
	}
	ct := o.ConnectTimeout
	if ct == 0 {
		ct = ConnectTimeout
	}
	ht := o.HeadersTimeout
	if ht == 0 {
		ht = HeadersTimeout
	}
	d := &gonet.Dialer{Timeout: ct, KeepAlive: KeepAliveTimeout}
	var ep *envProxy
	if ProxyEnvActive(o.Env) {
		ep = newEnvProxy(o.Env)
	}
	direct := func(ctx context.Context, network, addr string) (gonet.Conn, error) {
		host, port, err := gonet.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		var addrs []LookupAddress
		if p, ok := ctx.Value(pinKey{}).(*pin); ok && p.host == host {
			addrs = p.addrs
		} else {
			raw := "http://" + URLHost(host) + "/"
			_, addrs, err = ResolveUpstreamAddresses(ctx, raw, getGuard())
			if err != nil {
				return nil, err
			}
		}
		var last error
		for _, a := range addrs {
			c, err := d.DialContext(ctx, network, gonet.JoinHostPort(a.Address, port))
			if err == nil {
				return c, nil
			}
			last = err
		}
		if last == nil {
			last = errors.New("ENOTFOUND " + host)
		}
		return nil, last
	}
	dial := func(ctx context.Context, network, addr string) (gonet.Conn, error) {
		if ep != nil {
			if ep.err != nil {
				return nil, ep.err
			}
			if t, ok := ctx.Value(targetKey{}).(*target); ok {
				if px := ep.pick(t.scheme, t.host, t.port); px != nil {
					cctx, cancel := context.WithTimeout(ctx, ct)
					defer cancel()
					return dialViaProxy(cctx, d, px, addr)
				}
			}
		}
		return direct(ctx, network, addr)
	}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           dial,
		MaxConnsPerHost:       MaxConnsPerHost,
		MaxIdleConnsPerHost:   MaxConnsPerHost,
		IdleConnTimeout:       KeepAliveTimeout,
		ResponseHeaderTimeout: ht,
		TLSHandshakeTimeout:   ct,
		// undici speaks HTTP/1.1 only (allowH2 defaults to false)
		ForceAttemptHTTP2: false,
		// accept-encoding 与解码按 undici 自己做（decode.go），不用 net/http 的透明 gzip
		DisableCompression: true,
		TLSNextProto:       map[string]func(string, *tls.Conn) http.RoundTripper{},
	}
}

// CreateUpstreamFetch is createUpstreamFetch.
func CreateUpstreamFetch(o FetchOptions) UpstreamFetch {
	var once sync.Once
	var client *http.Client
	getGuard := o.GetGuard
	if getGuard == nil {
		getGuard = func() GuardOpts { return GuardOpts{} }
	}
	return func(req *http.Request) (*http.Response, error) {
		u, addrs, err := ResolveUpstreamAddresses(req.Context(), req.URL.String(), getGuard())
		if err != nil {
			return nil, err
		}
		once.Do(func() {
			client = &http.Client{
				Transport:     NewTransport(o),
				CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			}
		})
		ctx := context.WithValue(req.Context(), pinKey{}, &pin{host: stripBrackets(u.Hostname()), addrs: addrs})
		h := u.Host
		if p := u.Port(); p != "" {
			h = h[:len(h)-len(p)-1]
		}
		port, _ := strconv.Atoi(u.Port())
		if port == 0 {
			port, _ = strconv.Atoi(defaultPort(u.Scheme))
		}
		ctx = context.WithValue(ctx, targetKey{}, &target{scheme: u.Scheme, host: h, port: port})
		req.URL.Host = u.Host
		fetchDefaultHeaders(req.Header)
		acceptEncodingDefaults(req)
		resp, err := client.Do(req.WithContext(ctx))
		if err != nil {
			return nil, err
		}
		if err := decodeResponse(req.Method, resp); err != nil {
			return nil, err
		}
		return resp, nil
	}
}

var (
	sharedOnce  sync.Once
	sharedFetch UpstreamFetch
)

// DefaultUpstreamFetch is defaultUpstreamFetch.
func DefaultUpstreamFetch() UpstreamFetch {
	sharedOnce.Do(func() { sharedFetch = CreateUpstreamFetch(FetchOptions{}) })
	return sharedFetch
}

// fetchDefaultHeaders adds the request headers Node's fetch (undici) sends
// when the caller did not set them (accept-encoding: see decode.go).
func fetchDefaultHeaders(h http.Header) {
	for _, kv := range [][2]string{{"Accept", "*/*"}, {"Accept-Language", "*"}, {"Sec-Fetch-Mode", "cors"}, {"User-Agent", "undici"}} {
		if _, ok := h[kv[0]]; !ok && h.Get(kv[0]) == "" {
			h.Set(kv[0], kv[1])
		}
	}
}
