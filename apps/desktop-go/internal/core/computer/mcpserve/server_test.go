package mcpserve

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type labelKey struct{}

func testServer(t *testing.T) (*Server, *[]string) {
	t.Helper()
	var seen []string
	defs := []tools.Definition{
		{Name: "computer_snapshot", Description: "read", Input: u.NewObj("type", "object"),
			Execute: func(ctx context.Context, in any, _ tools.ExecContext) (any, error) {
				l, _ := ctx.Value(labelKey{}).(string)
				seen = append(seen, l+"|"+tools.ConversationFrom(ctx)+"|"+u.Stringify(in))
				return u.NewObj("ok", true, "data", u.NewObj("tree", "x")), nil
			}},
		{Name: "computer_click", Description: "click", Input: u.NewObj("type", "object"),
			Execute: func(context.Context, any, tools.ExecContext) (any, error) {
				return u.NewObj("ok", false, "error", u.NewObj("code", "user_denied")), nil
			}},
	}
	s := New(Options{Dir: t.TempDir() + "/mcp", Tools: defs,
		Wrap: func(ctx context.Context, l, _ string) context.Context { return context.WithValue(ctx, labelKey{}, l) }})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, &seen
}

func readCfg(t *testing.T, file string) (url, token string) {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var c struct{ URL, Token string }
	_ = json.Unmarshal(b, &c)
	return c.URL, c.Token
}

func post(t *testing.T, url, token, body string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return resp.StatusCode, m
}

func TestTokenFileAndAuth(t *testing.T) {
	s, _ := testServer(t)
	file, err := s.Launch("tab1", "Claude Code", false)
	if err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode %v", fi.Mode().Perm())
	}
	again, _ := s.Launch("tab1", "Claude Code", false)
	if again != file {
		t.Fatal("same tab should reuse its token file")
	}
	url, tok := readCfg(t, file)
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	if c, _ := post(t, url, "", ping, nil); c != http.StatusUnauthorized {
		t.Fatalf("no token: %d", c)
	}
	if c, _ := post(t, url, "nope", ping, nil); c != http.StatusUnauthorized {
		t.Fatalf("bad token: %d", c)
	}
	if c, _ := post(t, url, tok, ping, map[string]string{"Origin": "https://evil.example"}); c != http.StatusForbidden {
		t.Fatalf("browser origin: %d", c)
	}
	if c, m := post(t, url, tok, ping, nil); c != 200 || m["result"] == nil {
		t.Fatalf("ping: %d %v", c, m)
	}
	if c, _ := post(t, url, tok, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil); c != http.StatusAccepted {
		t.Fatalf("notification: %d", c)
	}
	s.Revoke("tab1")
	if c, _ := post(t, url, tok, ping, nil); c != http.StatusUnauthorized {
		t.Fatalf("revoked token: %d", c)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("revoked token file should be removed")
	}
}

func TestToolsListAndCall(t *testing.T) {
	s, seen := testServer(t)
	file, _ := s.Launch("tab1", "Codex", false)
	url, tok := readCfg(t, file)
	_, m := post(t, url, tok, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`, nil)
	if r := m["result"].(map[string]any); r["protocolVersion"] != "2025-03-26" {
		t.Fatalf("initialize: %v", m)
	}
	_, m = post(t, url, tok, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, nil)
	if n := len(m["result"].(map[string]any)["tools"].([]any)); n != 2 {
		t.Fatalf("tools/list: %v", m)
	}
	_, m = post(t, url, tok, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"computer_snapshot","arguments":{"app":"Notes"}}}`, nil)
	r := m["result"].(map[string]any)
	if r["isError"] != false || !strings.Contains(r["content"].([]any)[0].(map[string]any)["text"].(string), `"tree"`) {
		t.Fatalf("call: %v", m)
	}
	if got := (*seen)[0]; got != `Codex|cli-tab:tab1|{"app":"Notes"}` {
		t.Fatalf("ctx/args: %s", got)
	}
	_, m = post(t, url, tok, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"computer_click","arguments":{"ref":"@s:e1"}}}`, nil)
	if m["result"].(map[string]any)["isError"] != true {
		t.Fatalf("denied call should be isError: %v", m)
	}
	_, m = post(t, url, tok, `{"jsonrpc":"2.0","id":5,"method":"nope"}`, nil)
	if m["error"] == nil {
		t.Fatalf("unknown method: %v", m)
	}
}

func TestReadOnlyHidesActions(t *testing.T) {
	s, _ := testServer(t)
	file, _ := s.Launch("tab1", "Claude Code", true)
	url, tok := readCfg(t, file)
	_, m := post(t, url, tok, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, nil)
	list := m["result"].(map[string]any)["tools"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["name"] != "computer_snapshot" {
		t.Fatalf("plan mode should only list read tools: %v", list)
	}
	_, m = post(t, url, tok, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"computer_click","arguments":{}}}`, nil)
	if m["error"] == nil {
		t.Fatalf("plan mode click should be rejected: %v", m)
	}
}

func TestBridge(t *testing.T) {
	s, _ := testServer(t)
	file, _ := s.Launch("tab1", "Gemini CLI", false)
	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n" +
		`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n")
	var out, errOut bytes.Buffer
	if code := Bridge(file, in, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 responses (notification has none), got %q", out.String())
	}
	for _, l := range lines {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) != nil || m["result"] == nil {
			t.Fatalf("bad line %q", l)
		}
	}
}

func TestBridgeServerGone(t *testing.T) {
	s, _ := testServer(t)
	file, _ := s.Launch("tab1", "Codex", false)
	s.Close()
	// Close 删掉了 token 文件：桥接直接报错退出
	if code := Bridge(file, strings.NewReader(""), io.Discard, io.Discard); code != 1 {
		t.Fatalf("missing token file should exit 1, got %d", code)
	}
}

func TestStopAllCancelsAndRenews(t *testing.T) {
	s, _ := testServer(t)
	_, _ = s.Launch("tab1", "Codex", false)
	s.mu.Lock()
	old := s.tabs["tab1"].ctx
	s.mu.Unlock()
	s.StopAll()
	if old.Err() == nil {
		t.Fatal("old context should be cancelled")
	}
	s.mu.Lock()
	cur := s.tabs["tab1"].ctx
	s.mu.Unlock()
	if cur.Err() != nil || tools.ConversationFrom(cur) != "cli-tab:tab1" {
		t.Fatal("tab should get a fresh context with the same conversation")
	}
}
