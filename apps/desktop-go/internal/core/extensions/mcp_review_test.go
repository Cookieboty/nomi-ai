package extensions

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func remoteService(t *testing.T) (*Service, *operationRuntime) {
	t.Helper()
	root := t.TempDir()
	s := New(Deps{Root: filepath.Join(root, "extensions"), SkillsRoot: filepath.Join(root, "skills")})
	runtime := &operationRuntime{}
	s.Attach(func() McpRuntime { return runtime }, operationRegistry{})
	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "name": "Remote", "transport": "http", "url": "https://mcp.example.com/mcp"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Dispose)
	return s, runtime
}

// 列表只读：不为没用过授权的服务新建会话（不读盘解密），有授权记录时如实标出
func TestListMcpDoesNotCreateOAuthSessions(t *testing.T) {
	s, _ := remoteService(t)
	has := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.hasAuthorization(s.find("remote"))
	}
	s.ListMcp()
	s.mu.Lock()
	sessions := len(s.oauth)
	s.mu.Unlock()
	if sessions != 0 || has() {
		t.Fatalf("list created %d sessions, hasAuthorization=%v", sessions, has())
	}
	file := oauthFile(s.d.Root, "remote")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("enc:x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.ListMcp()
	s.mu.Lock()
	sessions = len(s.oauth)
	s.mu.Unlock()
	if sessions != 0 || !has() {
		t.Fatalf("stored authorization: sessions=%d hasAuthorization=%v", sessions, has())
	}
}

func TestDisconnectReleasesClosingMarker(t *testing.T) {
	s, _ := remoteService(t)
	s.Disconnect(context.Background(), "remote")
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.closing) != 0 {
		t.Fatalf("closing markers left behind: %d", len(s.closing))
	}
}

// 远程连接失败：认得出的原因照常提示，认不出的原始报错换成通用提示
func TestRemoteConnectErrorKeepsKnownReasons(t *testing.T) {
	s, runtime := remoteService(t)
	generic := T("ui.foundation.mcp-remote-connection-failed")
	for _, tc := range []struct {
		err     string
		generic bool
	}{
		{"fetch failed: ECONNREFUSED", false},
		{"HTTP 401 unauthorized", false},
		{"request timed out", false},
		{"server said: <html>secret body</html>", true},
	} {
		runtime.connect = func(context.Context, McpConnectConfig) error { return errors.New(tc.err) }
		_, _ = s.Connect(context.Background(), "remote")
		s.mu.Lock()
		live := s.live["remote"]
		s.mu.Unlock()
		if live.Status != "error" || (live.Error == generic) != tc.generic {
			t.Fatalf("%q → %+v", tc.err, live)
		}
		if strings.Contains(live.Error, "secret body") {
			t.Fatalf("raw remote error leaked: %q", live.Error)
		}
	}
}
