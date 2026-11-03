package accounts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Codex：config.toml 里的相对路径（cc-switch 的模型目录等）也链进账号目录，凭据除外（同 accounts.test.ts）
func TestEnsureAccountHomeLinksCodexConfigRefs(t *testing.T) {
	root := t.TempDir()
	cx := filepath.Join(root, "user")
	acct := filepath.Join(root, "acct")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(cx, "prompts-x"), 0o700))
	must(os.WriteFile(filepath.Join(cx, "config.toml"), []byte(strings.Join([]string{
		`model_catalog_json = "cc-switch-model-catalog.json"`,
		`model_instructions_file = 'prompts-x/base.md' # 注释`,
		`experimental_auth_file = "auth.json"`,
		`model_instructions_path = "/abs/elsewhere.md"`,
		`missing_file = "nope.json"`,
		`model = "catalog.json"`,
	}, "\n")), 0o600))
	for _, f := range []string{"cc-switch-model-catalog.json", "prompts-x/base.md", "auth.json", "catalog.json"} {
		must(os.WriteFile(filepath.Join(cx, f), []byte("{}"), 0o600))
	}
	problems, err := EnsureAccountHome("codex", acct, cx, "darwin")
	must(err)
	if len(problems) != 0 {
		t.Fatalf("problems: %+v", problems)
	}
	for _, n := range []string{"cc-switch-model-catalog.json", "prompts-x", "config.toml"} {
		st, err := os.Lstat(filepath.Join(acct, n))
		if err != nil || st.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s should be a symlink (err=%v)", n, err)
		}
	}
	for _, n := range []string{"auth.json", "catalog.json", "nope.json"} {
		if _, err := os.Lstat(filepath.Join(acct, n)); err == nil {
			t.Fatalf("%s must not be linked", n)
		}
	}
}
