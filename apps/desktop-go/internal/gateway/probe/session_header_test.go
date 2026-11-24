package probe

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func probeTestLookup(context.Context, string) ([]net.LookupAddress, error) {
	return []net.LookupAddress{{Address: "93.184.216.34", Family: 4}}, nil
}

func probeTestResp(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func minimalInferenceBody(path string) string {
	switch {
	case strings.HasSuffix(path, "/responses"):
		return `{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`
	case strings.HasSuffix(path, "/messages"):
		return `{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}`
	default:
		return `{"id":"chatcmpl_1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`
	}
}

func headerCI(h http.Header, name string) string {
	for k, vs := range h {
		if strings.EqualFold(k, name) && len(vs) > 0 {
			return vs[0]
		}
	}
	return ""
}

func TestProbeSessionHeader(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	modelsSeen := map[string]string{}
	var chatAuthAttempts []string
	fetch := func(req *http.Request) (*http.Response, error) {
		h := headerCI(req.Header, "x-opencode-session")
		if req.Method == "GET" && strings.HasSuffix(req.URL.Path, "/models") {
			mu.Lock()
			modelsSeen[req.Header.Get("Authorization")+req.Header.Get("x-api-key")] = h
			mu.Unlock()
			return probeTestResp(req, 200, `{"data":[{"id":"kimi-k3"}]}`), nil
		}
		mu.Lock()
		seen[req.URL.Path] = h
		if strings.HasSuffix(req.URL.Path, "/chat/completions") {
			chatAuthAttempts = append(chatAuthAttempts, h)
		}
		mu.Unlock()
		if h == "" {
			return probeTestResp(req, 400, "missing x-opencode-session"), nil
		}
		// 验证 401 切换鉴权头重试时仍携带同一临时会话 ID
		if strings.HasSuffix(req.URL.Path, "/chat/completions") && req.Header.Get("Authorization") != "" {
			return probeTestResp(req, 401, `{"error":{"message":"use x-api-key"}}`), nil
		}
		return probeTestResp(req, 200, minimalInferenceBody(req.URL.Path)), nil
	}

	bases := u.NewObj(
		"chat", "https://opencode.example.test/inference/go/openai/v1",
		"responses", "https://opencode.example.test/inference/go/openai/v1",
		"messages", "https://opencode.example.test/inference/go/anthropic/v1",
	)

	r := Detect(Options{
		Bases:         bases,
		Keys:          []Key{{ID: "k", Value: "sk-test"}},
		SessionHeader: "x-opencode-session",
		FetchImpl:     fetch,
		LookupAll:     probeTestLookup,
	})
	wires := r.Get("wires").(*u.Obj)
	for _, w := range []string{"chat", "responses", "messages"} {
		ln := wires.Get(w).(*u.Obj)
		if ln.Get("ok") != true {
			t.Fatalf("%s probe failed with session header: %s", w, u.Stringify(ln))
		}
	}
	mu.Lock()
	cSess := seen["/inference/go/openai/v1/chat/completions"]
	rSess := seen["/inference/go/openai/v1/responses"]
	mSess := seen["/inference/go/anthropic/v1/messages"]
	modSess := ""
	for _, v := range modelsSeen {
		if v != "" {
			modSess = v
			break
		}
	}
	attempts := append([]string(nil), chatAuthAttempts...)
	mu.Unlock()
	if cSess == "" || !strings.HasPrefix(cSess, "nomi:probe:") || cSess != rSess || cSess != mSess || cSess != modSess {
		t.Fatalf("expected all /models and inference probes to share one nomi:probe: session header, got models=%q chat=%q responses=%q messages=%q", modSess, cSess, rSess, mSess)
	}
	if len(attempts) != 2 || attempts[0] != attempts[1] {
		t.Fatalf("expected auth retry to keep same session header, got %v", attempts)
	}

	// 未配置 SessionHeader 时，不发送该请求头
	mu.Lock()
	seen = map[string]string{}
	modelsSeen = map[string]string{}
	mu.Unlock()
	r2 := Detect(Options{
		Bases:     u.NewObj("chat", "https://opencode.example.test/inference/go/openai/v1"),
		Keys:      []Key{{ID: "k", Value: "sk-test"}},
		FetchImpl: fetch,
		LookupAll: probeTestLookup,
	})
	if ln := r2.Get("wires").(*u.Obj).Get("chat").(*u.Obj); ln.Get("ok") == true {
		t.Fatalf("expected probe without session header to fail 400 plain-text check, got %s", u.Stringify(ln))
	}
	if seen["/inference/go/openai/v1/chat/completions"] != "" {
		t.Fatalf("must not send x-opencode-session when SessionHeader is empty: %v", seen)
	}
	for _, v := range modelsSeen {
		if v != "" {
			t.Fatalf("must not send x-opencode-session on /models when SessionHeader is empty: %v", modelsSeen)
		}
	}
}

func TestProbeStrictRejects400ErrorsAndInvalid200WhilePreservingLegacy400(t *testing.T) {
	// 1. 有会话头（或开启 RequireInferenceOK）时，返回常见 JSON 格式的 400（如缺头错误）绝不能标为 ok: true
	for _, body := range []string{
		`{"error":{"message":"missing x-opencode-session"}}`,
		`{"type":"error","error":{"type":"invalid_request_error","message":"missing session header"}}`,
	} {
		fetch400 := func(req *http.Request) (*http.Response, error) {
			if req.Method == "GET" {
				return probeTestResp(req, 200, `{"data":[{"id":"kimi-k3"}]}`), nil
			}
			// 先返回 401 再返回 400，也必须拦截掉 r2.status == 400
			if strings.HasSuffix(req.URL.Path, "/messages") && req.Header.Get("x-api-key") != "" {
				return probeTestResp(req, 401, `{"error":{"message":"retry with bearer"}}`), nil
			}
			return probeTestResp(req, 400, body), nil
		}
		r := Detect(Options{
			Bases:         u.NewObj("chat", "https://opencode.example.test/v1", "messages", "https://opencode.example.test"),
			Keys:          []Key{{ID: "k", Value: "sk-test"}},
			SessionHeader: "x-opencode-session",
			FetchImpl:     fetch400,
			LookupAll:     probeTestLookup,
		})
		wires := r.Get("wires").(*u.Obj)
		for _, w := range []string{"chat", "messages"} {
			ln := wires.Get(w).(*u.Obj)
			if ln.Get("ok") == true {
				t.Fatalf("strict probe accepted 400 JSON error %s on %s: %s", body, w, u.Stringify(ln))
			}
			if w == "chat" && ln.Get("status") != float64(400) {
				t.Fatalf("expected status 400 on chat error, got %s", u.Stringify(ln))
			}
		}

		// RequireInferenceOK 单独开启（无 SessionHeader）也拒绝 JSON 400
		rStrictOnly := Detect(Options{
			Bases:              u.NewObj("chat", "https://opencode.example.test/v1"),
			Keys:               []Key{{ID: "k", Value: "sk-test"}},
			RequireInferenceOK: true,
			FetchImpl:          fetch400,
			LookupAll:          probeTestLookup,
		})
		if ln := rStrictOnly.Get("wires").(*u.Obj).Get("chat").(*u.Obj); ln.Get("ok") == true {
			t.Fatalf("RequireInferenceOK accepted 400 JSON error %s: %s", body, u.Stringify(ln))
		}
	}

	// 2. 严格模式下，伪装 200 错误包或非推理结果页均不能标为可用
	for _, invalid200 := range []string{
		`{"error":{"message":"missing x-opencode-session"}}`,
		`{"status":"ok"}`,
		`<html><body>welcome</body></html>`,
	} {
		fetchInvalid200 := func(req *http.Request) (*http.Response, error) {
			if req.Method == "GET" {
				return probeTestResp(req, 200, `{"data":[{"id":"kimi-k3"}]}`), nil
			}
			return probeTestResp(req, 200, invalid200), nil
		}
		r := Detect(Options{
			Bases:         u.NewObj("chat", "https://opencode.example.test/v1", "responses", "https://opencode.example.test/v1", "messages", "https://opencode.example.test"),
			Keys:          []Key{{ID: "k", Value: "sk-test"}},
			SessionHeader: "x-opencode-session",
			FetchImpl:     fetchInvalid200,
			LookupAll:     probeTestLookup,
		})
		wires := r.Get("wires").(*u.Obj)
		for _, w := range []string{"chat", "responses", "messages"} {
			if ln := wires.Get(w).(*u.Obj); ln.Get("ok") == true {
				t.Fatalf("strict probe accepted invalid 200 payload %q on %s: %s", invalid200, w, u.Stringify(ln))
			}
		}
	}

	// 3. 普通旧预设（无 SessionHeader 且 RequireInferenceOK=false）保持原有 400 参数错误识别兼容
	fetchLegacy := func(req *http.Request) (*http.Response, error) {
		if req.Method == "GET" {
			return probeTestResp(req, 200, `{"data":[{"id":"gpt-4o"}]}`), nil
		}
		return probeTestResp(req, 400, `{"error":{"message":"invalid max_tokens"}}`), nil
	}
	rLegacy := Detect(Options{
		Bases:     u.NewObj("chat", "https://legacy.example.test/v1"),
		Keys:      []Key{{ID: "k", Value: "sk-test"}},
		FetchImpl: fetchLegacy,
		LookupAll: probeTestLookup,
	})
	if ln := rLegacy.Get("wires").(*u.Obj).Get("chat").(*u.Obj); ln.Get("ok") != true || ln.Get("status") != float64(400) {
		t.Fatalf("legacy preset should preserve 400 param error recognition, got %s", u.Stringify(ln))
	}
}
