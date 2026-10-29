package net

import (
	"context"
	"errors"
	gonet "net"
	"net/http"
	"os"
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

type pin struct {
	host  string
	addrs []LookupAddress
}

// ProxyEnvActive is proxyEnvActive.
func ProxyEnvActive(env func(string) string) bool {
	if env == nil {
		env = os.Getenv
	}
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		if env(k) != "" {
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
	dial := func(ctx context.Context, network, addr string) (gonet.Conn, error) {
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
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dial,
		MaxConnsPerHost:       MaxConnsPerHost,
		MaxIdleConnsPerHost:   MaxConnsPerHost,
		IdleConnTimeout:       KeepAliveTimeout,
		ResponseHeaderTimeout: ht,
		TLSHandshakeTimeout:   ct,
		ForceAttemptHTTP2:     true,
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
		return client.Do(req.WithContext(ctx))
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

