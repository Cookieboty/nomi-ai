package assetproto

import (
	"os"
	"path/filepath"
	"testing"
)

// chat-asset://themes/：自定义主题的背景图（userData/chat/themes）
func TestResolveThemeBackground(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "themes")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "abc-12ab.png"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "secret.png"), []byte("x"), 0o644)

	if got := ResolveChatAssetURL(root, "chat-asset://themes/abc-12ab.png", ""); filepath.Base(got) != "abc-12ab.png" {
		t.Fatalf("resolve: %q", got)
	}
	for _, u := range []string{
		"chat-asset://themes/../secret.png",
		"chat-asset://themes/%2e%2e/secret.png",
		"chat-asset://themes/abc-12ab.txt",
		"chat-asset://themes/missing.png",
	} {
		if got := ResolveChatAssetURL(root, u, ""); got != "" {
			t.Errorf("%s should not resolve, got %q", u, got)
		}
	}
}
