package net

import (
	"context"
	gonet "net"
	"net/url"
	"strconv"
	"strings"
)

// LookupAddress is dns.LookupAddress.
type LookupAddress struct {
	Address string
	Family  int
}

// LookupAll resolves every address of host.
type LookupAll func(ctx context.Context, host string) ([]LookupAddress, error)

func defaultLookupAll(ctx context.Context, host string) ([]LookupAddress, error) {
	ips, err := gonet.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]LookupAddress, 0, len(ips))
	for _, ip := range ips {
		fam := 6
		if ip.IP.To4() != nil {
			fam = 4
		}
		out = append(out, LookupAddress{Address: ip.IP.String(), Family: fam})
	}
	return out, nil
}

// UpstreamBlockedError is UpstreamBlockedError.
type UpstreamBlockedError struct{ Msg string }

func (e *UpstreamBlockedError) Error() string { return e.Msg }

// GuardOpts is UpstreamGuardOpts.
type GuardOpts struct {
	AllowedPrivateHosts []string
	SelfPort            int
	LookupAll           LookupAll
}

func hostPort(u *url.URL) string {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(stripBrackets(u.Hostname())) + ":" + port
}

// IsFakeIp is isFakeIp (proxy fake-ip range 198.18.0.0/15).
func IsFakeIp(address string) bool {
	v4 := ParseIPv4(address)
	return v4 != nil && v4[0] == 198 && (v4[1] == 18 || v4[1] == 19)
}

func isLoopbackName(host string) bool {
	h := strings.ToLower(stripBrackets(host))
	if h == "localhost" || h == "::1" {
		return true
	}
	v4 := ParseIPv4(h)
	return v4 != nil && v4[0] == 127
}

func blocked(msg string) error { return &UpstreamBlockedError{Msg: msg} }

// ResolveUpstreamAddresses is resolveUpstreamAddresses.
func ResolveUpstreamAddresses(ctx context.Context, raw string, o GuardOpts) (*url.URL, []LookupAddress, error) {
	u, err := ParseURL(raw)
	if err != nil || u.Host == "" {
		return nil, nil, blocked("上游地址无效：" + raw)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, nil, blocked("上游地址只允许 http / https")
	}
	if u.User != nil {
		return nil, nil, blocked("上游地址不能包含账号密码")
	}
	hp := hostPort(u)
	allowed := map[string]bool{}
	for _, x := range o.AllowedPrivateHosts {
		allowed[strings.ToLower(x)] = true
	}
	host := stripBrackets(u.Hostname())
	if o.SelfPort != 0 && isLoopbackName(host) && strings.HasSuffix(hp, ":"+strconv.Itoa(o.SelfPort)) {
		return nil, nil, blocked("上游地址不能指向 Nomi 网关自己")
	}
	if IsPrivateHost(host) {
		if !allowed[hp] {
			return nil, nil, blocked("上游地址 " + hp + " 是本机或局域网地址，需要先在供应商设置里确认")
		}
		if ParseIPv4(host) != nil {
			return u, []LookupAddress{{host, 4}}, nil
		}
		if ParseIPv6(host) != nil {
			return u, []LookupAddress{{host, 6}}, nil
		}
	}
	if (ParseIPv4(host) != nil || ParseIPv6(host) != nil) && !IsPrivateHost(host) {
		fam := 6
		if ParseIPv4(host) != nil {
			fam = 4
		}
		return u, []LookupAddress{{host, fam}}, nil
	}
	look := o.LookupAll
	if look == nil {
		look = defaultLookupAll
	}
	addrs, err := look(ctx, host)
	if err != nil {
		return nil, nil, err
	}
	if len(addrs) == 0 {
		return nil, nil, blocked("无法解析上游地址 " + host)
	}
	nBlocked := 0
	for _, a := range addrs {
		if IsPrivateHost(a.Address) && !IsFakeIp(a.Address) {
			nBlocked++
		}
	}
	msg := "上游地址 " + host + " 解析到了本机或局域网地址，需要先在供应商设置里确认"
	if nBlocked > 0 && !allowed[hp] {
		return nil, nil, blocked(msg)
	}
	usable := addrs
	if !(allowed[hp] || nBlocked == 0) {
		usable = nil
		for _, a := range addrs {
			if !IsPrivateHost(a.Address) || IsFakeIp(a.Address) {
				usable = append(usable, a)
			}
		}
	}
	if len(usable) == 0 {
		return nil, nil, blocked(msg)
	}
	return u, usable, nil
}

// CheckUpstream is checkUpstream.
func CheckUpstream(ctx context.Context, raw string, o GuardOpts) (*url.URL, error) {
	u, _, err := ResolveUpstreamAddresses(ctx, raw, o)
	return u, err
}
