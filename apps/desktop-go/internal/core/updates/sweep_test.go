package updates

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSweepObsoleteInstallers(t *testing.T) {
	dir := t.TempDir()
	keep := []string{
		"Nomi-Setup-2.3.11.exe",     // 下好了还没装
		"Nomi-2.3.11-arm64-mac.zip", // 下好了还没装
		"notes.txt",                 // 不是安装包
		"Nomi-notes.dmg",            // 名字里没有版本
		"readme",                    // 没有扩展名
	}
	drop := []string{
		"Nomi-2.3.8-arm64.dmg",
		"Nomi-2.3.9.dmg",
		"Nomi-2.3.10-arm64-mac.zip",
		"Nomi-2.3.10-mac.zip",
		"Nomi-Setup-2.3.10.exe",
		"Nomi-2.3.9.AppImage",
		"nomi_2.3.7_amd64.deb",
		"Nomi-2.3.10-beta.1-arm64.dmg", // 预发布比正在运行的正式版旧
		"Nomi-Setup-2.4.0.exe.part",    // 没下完，下次会重下
		"Nomi-2.3.8.AppImage.part",
	}
	for _, name := range append(append([]string{}, keep...), drop...) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 目录和符号链接不是安装包本体，不能删
	if err := os.Mkdir(filepath.Join(dir, "Nomi-1.0.0.dmg"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "keep.txt")
	if err := os.WriteFile(outside, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "Nomi-1.0.0.exe")); err != nil {
		t.Fatal(err)
	}

	removed := SweepObsoleteInstallers(dir, "2.3.10")
	if len(removed) != len(drop) {
		t.Fatalf("removed %v, want %d files", removed, len(drop))
	}
	for _, name := range drop {
		if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still there (%v)", name, err)
		}
	}
	for _, name := range keep {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s should stay: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "Nomi-1.0.0.dmg")); err != nil {
		t.Fatal("directory should stay")
	}
	if _, err := os.Lstat(filepath.Join(dir, "Nomi-1.0.0.exe")); err != nil {
		t.Fatal("symlink should stay")
	}
	if b, _ := os.ReadFile(outside); string(b) != "keep" {
		t.Fatal("symlink target was removed")
	}
	if left := SweepObsoleteInstallers(dir, "2.3.10"); len(left) != 0 {
		t.Fatalf("second sweep removed %v", left)
	}
	if SweepObsoleteInstallers(filepath.Join(dir, "missing"), "2.3.10") != nil {
		t.Fatal("missing dir")
	}
	if SweepObsoleteInstallers(dir, "") != nil {
		t.Fatal("empty version must not delete")
	}
}

func TestSweepKeepsPendingWhenCurrentIsOlder(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"Nomi-Setup-2.3.10.exe", "nomi_2.3.9_amd64.deb"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	SweepObsoleteInstallers(dir, "2.3.9")
	if _, err := os.Stat(filepath.Join(dir, "Nomi-Setup-2.3.10.exe")); err != nil {
		t.Fatal("newer installer must stay until it is installed")
	}
	if _, err := os.Stat(filepath.Join(dir, "nomi_2.3.9_amd64.deb")); !os.IsNotExist(err) {
		t.Fatal("installed version's deb should go")
	}
}

// 直接从缓存目录打开的 AppImage 正在运行：版本等于当前版本也不能删。
func TestSweepKeepsRunningFile(t *testing.T) {
	dir := t.TempDir()
	running := filepath.Join(dir, "Nomi-2.3.10.AppImage")
	old := filepath.Join(dir, "Nomi-2.3.9.AppImage")
	for _, p := range []string{running, old} {
		if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	removed := SweepObsoleteInstallers(dir, "2.3.10", "", running)
	if len(removed) != 1 || removed[0] != "Nomi-2.3.9.AppImage" {
		t.Fatalf("removed %v", removed)
	}
	if _, err := os.Stat(running); err != nil {
		t.Fatalf("running AppImage removed: %v", err)
	}
}
