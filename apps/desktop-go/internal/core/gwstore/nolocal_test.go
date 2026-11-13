package gwstore

import (
	"path/filepath"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 「新会话默认用」存过旧版本的本机登录（local-<kind>）：启动时改为跟随默认官方账号
func TestLegacyLocalNewTabAccountIsCleared(t *testing.T) {
	ud := t.TempDir()
	open := func() *Service {
		s := NewService(filepath.Join(ud, "gateway"), fakeCipher{}, nil, nil)
		port := 0
		s.AttachRuntime(RuntimeDeps{Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{}})
		if err := s.Init(); err != nil {
			t.Fatal(err)
		}
		return s
	}
	s := open()
	if err := s.SetAssignment("claude", u.NewObj("newTabSource", "official", "newTabAccountId", "local-claude")); err != nil {
		t.Fatal(err)
	}
	if got := s.CliDefaults("claude").Get("accountId"); got != "local-claude" {
		t.Fatalf("setup: accountId=%v", got)
	}
	s = open()
	d := s.CliDefaults("claude")
	if a := d.Get("accountId"); a != nil && a != u.Undefined {
		t.Fatalf("accountId=%v after restart, want follow the default account", a)
	}
	if d.Get("source") != "official" {
		t.Fatalf("source=%v", d.Get("source"))
	}
}
