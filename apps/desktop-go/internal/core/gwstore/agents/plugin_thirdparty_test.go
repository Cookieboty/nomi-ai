package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 插件给出的第三方启动（Launch.ThirdParty）：私有主目录指向会话目录，会话等链回用户目录，配置与凭据不链，
// 私有配置指向网关（Kimi Code、MiniMax Code）
func TestPluginThirdPartyLaunch(t *testing.T) {
	ctxW, vision := 200_000.0, true
	for _, c := range []struct {
		kind, homeEnv, userDir, config string
		linked, private                []string
		want                           []string
		keyEnv                         string
	}{
		{kind: "kimi", homeEnv: "KIMI_CODE_HOME", userDir: ".kimi-code", config: "config.toml",
			linked: []string{"sessions", "projects.json"}, private: []string{"credentials", "config.toml"},
			want:   []string{`base_url = "http://127.0.0.1:9/v1"`, `api_key_env = "NOMI_KIMI_API_KEY"`, `model = "openai/gpt-x"`, `"image_in"`, "max_context_size = 200000"},
			keyEnv: "NOMI_KIMI_API_KEY"},
		{kind: "minimax", homeEnv: "MINIMAX_DATA_DIR", userDir: ".minimax", config: "config.yaml",
			linked: []string{"v2", "plugins"}, private: []string{"auth", "config.yaml"},
			want: []string{`defaultModel: "custom_provider:nomi/openai/gpt-x"`, `baseURL: "http://127.0.0.1:9/v1"`,
				`apiKey: "tok-1"`, `"openai/gpt-x":`, "context: 200000", "support_image: true"}},
	} {
		t.Run(c.kind, func(t *testing.T) {
			home, dir := t.TempDir(), filepath.Join(t.TempDir(), "tab")
			user := filepath.Join(home, c.userDir)
			for _, n := range append(append([]string{}, c.linked...), c.private...) {
				p := filepath.Join(user, n)
				if strings.Contains(n, ".") {
					_ = os.MkdirAll(user, 0o700)
					_ = os.WriteFile(p, []byte("user"), 0o600)
				} else {
					_ = os.MkdirAll(p, 0o700)
				}
			}
			t.Setenv(c.homeEnv, "")
			l, err := AgentLaunchFor(c.kind, &LaunchContext{URL: "http://127.0.0.1:9", Token: "tok-1", Model: "openai/gpt-x",
				Dir: dir, Home: home, MetaOf: func(string) *ModelMeta { return &ModelMeta{Ctx: &ctxW, Vision: &vision} }})
			if err != nil {
				t.Fatal(err)
			}
			if l.Env.Get(c.homeEnv) != dir {
				t.Fatalf("%s = %v, want %s", c.homeEnv, l.Env.Get(c.homeEnv), dir)
			}
			if c.keyEnv != "" && l.Env.Get(c.keyEnv) != "tok-1" {
				t.Fatalf("%s = %v", c.keyEnv, l.Env.Get(c.keyEnv))
			}
			for _, n := range c.linked {
				if fi, err := os.Lstat(filepath.Join(dir, n)); err != nil || fi.Mode()&os.ModeSymlink == 0 {
					t.Errorf("%s should be linked back to the user dir (%v)", n, err)
				}
			}
			for _, n := range c.private {
				if fi, err := os.Lstat(filepath.Join(dir, n)); err == nil && fi.Mode()&os.ModeSymlink != 0 {
					t.Errorf("%s must not be linked into a third-party session", n)
				}
			}
			b, err := os.ReadFile(filepath.Join(dir, c.config))
			if err != nil {
				t.Fatal(err)
			}
			if fi, _ := os.Stat(filepath.Join(dir, c.config)); fi.Mode().Perm() != 0o600 {
				t.Errorf("%s mode = %v, want 0600", c.config, fi.Mode().Perm())
			}
			for _, w := range c.want {
				if !strings.Contains(string(b), w) {
					t.Errorf("%s missing %q:\n%s", c.config, w, b)
				}
			}
			if user, _ := os.ReadFile(filepath.Join(home, c.userDir, c.config)); string(user) != "user" {
				t.Errorf("the user's own %s was changed", c.config)
			}
		})
	}
}
