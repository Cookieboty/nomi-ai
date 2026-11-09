package gwstore

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
)

// 标签启动：插件写盘的配置（MiniMax 的 config.yaml）里是这次登记的标签令牌，不是这个端的全局令牌（#301）；
// 网关据此认出标签，换代后旧令牌的绑定被换掉
func TestCliLaunchForTabWritesTheTabToken(t *testing.T) {
	dir := t.TempDir()
	s := NewServiceForUserData(dir, nil, nil)
	port := 0
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Port: &port, Env: map[string]string{}})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Dispose()
	if !s.WhenReady(30 * time.Second) {
		t.Fatalf("not ready: %+v", s.Status())
	}
	ep := s.Endpoint("minimax")
	if ep == nil || ep.Token == "" {
		t.Skip("no minimax endpoint in this build")
	}
	apiKey := func() string {
		b, err := os.ReadFile(filepath.Join(s.AgentDir("minimax", "tab1"), "config.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		m := regexp.MustCompile(`apiKey: "([^"]+)"`).FindSubmatch(b)
		if m == nil {
			t.Fatalf("no apiKey in config.yaml:\n%s", b)
		}
		return string(m[1])
	}
	l, err := s.CliLaunchForTab("minimax", "tab1", "prov/model-a", "high", nil)
	if err != nil || l == nil {
		t.Fatalf("launch: %v %v", l, err)
	}
	k1 := apiKey()
	if k1 == ep.Token || !strings.HasPrefix(k1, route.TabTokenPrefix) {
		t.Fatalf("config.yaml carries %q, want this tab's own token (global is %q)", k1, ep.Token)
	}
	bound := func() *route.TabBinding {
		s.rt.tabs.mu.Lock()
		defer s.rt.tabs.mu.Unlock()
		return s.rt.tabs.active[tabKey("minimax", "tab1")]
	}
	if b := bound(); b == nil || b.TokenHash != route.HashTabToken(k1) || int(b.Generation) != l.Generation ||
		b.Effort == nil || *b.Effort != "high" {
		t.Fatalf("binding %+v does not match the token in config.yaml", b)
	}
	// 重新启动（换代）：新令牌写进配置，旧令牌不再是这个标签的绑定
	l2, err := s.CliLaunchForTab("minimax", "tab1", "prov/model-a", "", nil)
	if err != nil || l2 == nil || l2.Generation != l.Generation+1 {
		t.Fatalf("relaunch: %v %v", l2, err)
	}
	k2 := apiKey()
	if k2 == k1 || bound().TokenHash != route.HashTabToken(k2) {
		t.Fatal("relaunch writes the new generation's token and drops the old binding")
	}
	for _, v := range l2.Env.Keys() {
		if strings.Contains(l2.Env.Get(v).(string), ep.Token) {
			t.Fatalf("env %s still carries the global token", v)
		}
	}
}
