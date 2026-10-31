package assetproto

import (
	"os"
	"path/filepath"
	"testing"
)

// character-pack://assets/<packId>/<file>：只能落在远程素材缓存目录里（= Node resolveCharacterAssetUrl）
func TestResolveCharacterAssetURL(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nomi"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nomi", "a.riv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(filepath.Join(root, "nomi", "a.riv"))
	if got := ResolveCharacterAssetURL(root, "character-pack://assets/nomi/a.riv"); got != real {
		t.Fatalf("got %q want %q", got, real)
	}
	for _, u := range []string{
		"character-pack://pack/nomi/a.riv",
		"character-pack://assets/../etc/passwd",
		"character-pack://assets/nomi/%2e%2e/x",
		"chat-asset://assets/nomi/a.riv",
	} {
		if got := ResolveCharacterAssetURL(root, u); got != "" {
			t.Fatalf("%s resolved to %q", u, got)
		}
	}
	if got := ResolveCharacterAssetURL("", "character-pack://assets/nomi/a.riv"); got != "" {
		t.Fatalf("empty root resolved to %q", got)
	}
	// 覆盖包主机不会落到素材目录
	if got := ResolveCharacterPackURL(root, "character-pack://assets/nomi/a.riv"); got != "" {
		t.Fatalf("pack resolver accepted assets host: %q", got)
	}
}
