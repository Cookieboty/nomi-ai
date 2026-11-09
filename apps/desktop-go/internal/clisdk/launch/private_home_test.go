//go:build !windows

package launch

import (
	"os"
	"path/filepath"
	"testing"
)

// 插件把某个条目改成私有后，私有主目录里以前链过去的软链要去掉（MiniMax 拒绝软链的 v2），共享的照链
func TestEnsurePrivateHomeDropsLinksThatBecamePrivate(t *testing.T) {
	user, dir := t.TempDir(), t.TempDir()
	for _, d := range []string{"v2", "skills"} {
		if err := os.Mkdir(filepath.Join(user, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(user, "v2"), filepath.Join(dir, "v2")); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsurePrivateHome(dir, user, ".*", []string{`^v2$`}, "darwin"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "v2")); !os.IsNotExist(err) {
		t.Errorf("stale v2 link should be gone, lstat err = %v", err)
	}
	if st, err := os.Lstat(filepath.Join(dir, "skills")); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Errorf("skills should be linked, err = %v", err)
	}
}
