package gateway_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

// Wall-clock / duration fields in usage events (masked; presence and key order still compared).
var e2eTimeKeys = map[string]bool{"startedAt": true, "ms": true, "firstByteMs": true, "headersMs": true, "burst": true}

func maskE2E(v any, inTiming bool) any {
	switch x := v.(type) {
	case *u.Obj:
		for _, k := range x.Keys() {
			if e2eTimeKeys[k] || inTiming {
				x.Set(k, "<t>")
				continue
			}
			x.Set(k, maskE2E(x.Get(k), k == "timing"))
		}
	case []any:
		for i := range x {
			x[i] = maskE2E(x[i], false)
		}
	}
	return v
}

func e2eConfig(hostPort string, patch *u.Obj) *config.GatewayConfig {
	base := "http://" + hostPort
	prov := [][2]string{{"messages", "pm"}, {"responses", "pr"}, {"chat", "pc"}, {"gemini", "pg"}}
	ps := []any{}
	for _, p := range prov {
		url := base + "/" + p[0] + "/v1"
		if p[0] == "gemini" {
			url = base + "/gemini/v1beta"
		}
		ps = append(ps, u.NewObj("id", p[1], "name", strings.ToUpper(p[1]), "enabled", true,
			"urls", u.NewObj(p[0], url),
			"keys", []any{u.NewObj("id", "k1", "value", "key-"+p[1]+"-1", "enabled", true), u.NewObj("id", "k2", "value", "key-"+p[1]+"-2", "enabled", true)},
			"models", []any{u.NewObj("id", "m1", "enabled", true)}))
	}
	clients := u.NewObj()
	for _, c := range [][2]string{{"claude", "tok-claude"}, {"codex", "tok-codex"}, {"dsh", "tok-dsh"}, {"gemini", "tok-gemini"}} {
		clients.Set(c[0], u.NewObj("token", c[1], "models", u.NewObj("main", "pc/m1")))
	}
	o := u.NewObj("host", "127.0.0.1", "port", 0.0, "providers", ps, "clients", clients, "allowedPrivateHosts", []any{hostPort})
	if patch != nil {
		for _, k := range patch.Keys() {
			o.Set(k, patch.Get(k))
		}
	}
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(o)), &cfg); err != nil {
		panic(err)
	}
	return &cfg
}

// TestParityE2E replays scripts/parity/e2e.mjs: the Go GatewayServer in front of
// mockllm's scripted upstream must give the client the same status, headers and
// body, send the upstream the same requests and emit the same usage events.
func TestParityE2E(t *testing.T) {
	fx := loadJSFixture(t, "e2e")
	clientHeaders := strList(fx.Get("clientHeaders"))
	up, err := mockllm.StartScripted(strList(fx.Get("upstreamHeaders")))
	if err != nil {
		t.Fatal(err)
	}
	defer up.Close()
	hc := &http.Client{Transport: &http.Transport{DisableCompression: true}, Timeout: 30 * time.Second}
	tl := tally{}
	for _, cv := range fx.Get("cases").([]any) {
		c := cv.(*u.Obj)
		name := c.Get("name").(string)
		var script []mockllm.Step
		if err := json.Unmarshal([]byte(u.Stringify(c.Get("script"))), &script); err != nil {
			t.Fatal(err)
		}
		up.Set(script)
		patch, _ := c.Get("cfg").(*u.Obj)
		var mu sync.Mutex
		usage := []any{}
		g := server.CreateGateway(e2eConfig(up.HostPort, patch), server.GatewayHooks{OnUsage: func(e *u.Obj) {
			mu.Lock()
			usage = append(usage, e)
			mu.Unlock()
		}})
		if err := g.Start(); err != nil {
			t.Fatal(err)
		}
		rq := c.Get("req").(*u.Obj)
		body := rq.Get("body").(string)
		var rd io.Reader
		if body != "" {
			rd = bytes.NewReader([]byte(body))
		}
		req, _ := http.NewRequest(rq.Get("method").(string), g.ListenURL()+rq.Get("path").(string), rd)
		hs := rq.Get("headers").(*u.Obj)
		for _, k := range hs.Keys() {
			req.Header.Set(k, hs.Get(k).(string))
		}
		if _, ok := hs.Get("user-agent").(string); !ok {
			req.Header.Set("User-Agent", "")
		}
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		rb, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		time.Sleep(30 * time.Millisecond)
		g.Stop()

		want := c.Get("res").(*u.Obj)
		check(t, tl, "status", float64(resp.StatusCode), want.Get("status"), name)
		gh := u.NewObj()
		for _, k := range clientHeaders {
			if vs := resp.Header.Values(k); len(vs) > 0 {
				gh.Set(k, strings.Join(vs, ", "))
			}
		}
		check(t, tl, "headers", gh, want.Get("headers"), name)
		check(t, tl, "body", normalize(string(rb)), normalize(want.Get("body").(string)), name)

		seen := []any{}
		for _, s := range up.Seen() {
			h := u.NewObj()
			for _, k := range strList(fx.Get("upstreamHeaders")) {
				if v, ok := s.Headers[k]; ok {
					h.Set(k, v)
				}
			}
			seen = append(seen, u.NewObj("method", s.Method, "url", s.URL, "headers", h, "body", s.Body))
		}
		check(t, tl, "upstream", seen, c.Get("upstream"), name)

		mu.Lock()
		gu, _ := u.ParseString(u.Stringify(usage))
		mu.Unlock()
		wu, _ := u.ParseString(u.Stringify(c.Get("usage")))
		check(t, tl, "usage", normalize(u.Stringify(maskE2E(gu, false))), normalize(u.Stringify(maskE2E(wu, false))), name)
	}
	tl.report(t, "e2e")
}
