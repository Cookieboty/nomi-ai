package cli

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func resetShellProxy(t *testing.T, dir string) {
	t.Helper()
	ConfigureShellProxy(dir, nil)
	SetShellProxy(nil)
	t.Cleanup(func() {
		SetShellProxy(nil)
		ConfigureShellProxy("", nil)
	})
}

func TestParseShellEnv(t *testing.T) {
	out := "motd\n" + pathStart + "/usr/bin" + pathEnd + envStart +
		"HOME=/Users/x\nhttps_proxy=http://127.0.0.1:7890\nALL_PROXY=socks5://127.0.0.1:7891\n" +
		"no_proxy=corp.local\nhttp_proxy=\nOPENAI_API_KEY=sk-secret\n" + envEnd
	got := ParseShellEnv(out)
	want := map[string]string{
		"https_proxy": "http://127.0.0.1:7890",
		"ALL_PROXY":   "socks5://127.0.0.1:7891",
		"no_proxy":    "corp.local",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s = %q, want %q", k, got[k], v)
		}
	}
	if ParseShellPath(out) != "/usr/bin" {
		t.Fatalf("PATH parse broke: %q", ParseShellPath(out))
	}
	if len(ParseShellEnv("no markers")) != 0 {
		t.Fatal("expected empty")
	}
}

func TestWithShellProxyInjectsAndKeepsLoopbackDirect(t *testing.T) {
	resetShellProxy(t, t.TempDir())
	SetShellProxy(map[string]string{"https_proxy": "http://u:p@127.0.0.1:7890", "no_proxy": "corp.local"})
	env := WithShellProxy(util.NewObj("PATH", "/usr/bin"))
	if env.Get("https_proxy") != "http://u:p@127.0.0.1:7890" {
		t.Fatalf("https_proxy not injected: %v", env.Get("https_proxy"))
	}
	if env.Get("no_proxy") != "corp.local,localhost,127.0.0.1,::1" || env.Get("NO_PROXY") != env.Get("no_proxy") {
		t.Fatalf("no_proxy = %v / %v", env.Get("no_proxy"), env.Get("NO_PROXY"))
	}
	if DetectedShellProxy() != "http://127.0.0.1:7890" {
		t.Fatalf("credentials not redacted: %q", DetectedShellProxy())
	}
}

func TestWithShellProxyRespectsExistingEnvAndSwitch(t *testing.T) {
	dir := t.TempDir()
	resetShellProxy(t, dir)
	SetShellProxy(map[string]string{"https_proxy": "http://127.0.0.1:7890"})

	own := WithShellProxy(util.NewObj("HTTPS_PROXY", "http://corp:3128"))
	if own.Has("https_proxy") || own.Has("no_proxy") {
		t.Fatal("must not override a proxy the environment already has")
	}

	if !UseShellProxy() {
		t.Fatal("switch should default to on")
	}
	if err := SetUseShellProxy(false); err != nil {
		t.Fatal(err)
	}
	if WithShellProxy(util.NewObj()).Has("https_proxy") {
		t.Fatal("switch off must not inject")
	}
	// 开关持久化
	ConfigureShellProxy(dir, nil)
	if UseShellProxy() {
		t.Fatal("switch off should persist")
	}
}
