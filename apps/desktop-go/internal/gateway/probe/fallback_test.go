package probe

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 同 Node detect.test.ts：Responses 对改了名的 Claude 返回 503，换一个模型测通就算可用
func TestDetectFallsBackToAnotherModel(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	resp := func(req *http.Request, status int, body string) *http.Response {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(body)), Request: req}
	}
	fetch := func(req *http.Request) (*http.Response, error) {
		if req.Method == "GET" && strings.HasSuffix(req.URL.Path, "/v1/models") {
			return resp(req, 200, `{"data":[{"id":"Aerith-fable-5"},{"id":"Tifa-5.6-sol"}]}`), nil
		}
		b, _ := io.ReadAll(req.Body)
		var o struct{ Model string }
		_ = json.Unmarshal(b, &o)
		mu.Lock()
		seen = append(seen, req.URL.Path+" "+o.Model)
		mu.Unlock()
		if strings.HasSuffix(req.URL.Path, "/v1/responses") && o.Model == "Aerith-fable-5" {
			return resp(req, 503, `{"error":{"message":"no channel"}}`), nil
		}
		return resp(req, 200, `{"id":"x"}`), nil
	}
	r := Detect(Options{
		Bases:               u.NewObj("chat", "https://relay.example.test/v1", "responses", "https://relay.example.test/v1"),
		Keys:                []Key{{ID: "k", Value: "sk-test"}},
		FetchImpl:           fetch,
		AllowedPrivateHosts: nil,
		// 不走真实 DNS：Windows CI 上 relay.example.test 解析失败，模型列表都拿不到
		LookupAll: func(context.Context, string) ([]net.LookupAddress, error) {
			return []net.LookupAddress{{Address: "93.184.216.34", Family: 4}}, nil
		},
	})
	wires := r.Get("wires").(*u.Obj)
	res := wires.Get("responses").(*u.Obj)
	if res.Get("ok") != true || res.Get("model") != "Tifa-5.6-sol" {
		t.Fatalf("responses %s; seen %v", u.Stringify(res), seen)
	}
	if ch := wires.Get("chat").(*u.Obj); ch.Get("ok") != true {
		t.Fatalf("chat %s", u.Stringify(ch))
	}
}
