package extensions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

func oauthEndpoint(raw, server string) (*url.URL, error) {
	u, err := url.Parse(raw)
	selected, _ := url.Parse(server)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("invalid OAuth endpoint")
	}
	local := u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if local && selected != nil && u.Hostname() == selected.Hostname() {
		return u, nil
	}
	if u.Scheme != "https" {
		return nil, errors.New("OAuth requires HTTPS")
	}
	_, err = security.AssertPublicHttpUrl(raw)
	return u, err
}

func oauthRequest(ctx context.Context, server, raw, method, body, contentType string) (int, map[string]any, error) {
	u, err := oauthEndpoint(raw, server)
	if err != nil {
		return 0, nil, err
	}
	local := u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	tr := &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		if len(ips) == 0 {
			return nil, errors.New("OAuth DNS lookup failed")
		}
		for _, ip := range ips {
			if !local && gnet.IsPrivateHost(ip.IP.String()) {
				return nil, errors.New("OAuth private address blocked")
			}
		}
		return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("OAuth redirect blocked") }}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), strings.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 1024*1024+1))
	if err != nil || len(b) > 1024*1024 {
		return 0, nil, errors.New("invalid OAuth response")
	}
	var data map[string]any
	if json.Unmarshal(b, &data) != nil || data == nil {
		return 0, nil, errors.New("invalid OAuth response")
	}
	return res.StatusCode, data, nil
}
