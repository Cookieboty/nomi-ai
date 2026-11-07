package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

// 磁盘上的「始终允许」只认界面能点出来的：不存在的类别、相对路径、太宽的文件夹、永不授权的位置都丢掉
func TestNormalizeSandboxAllowValidates(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home")
	}
	proj := filepath.Join(home, "Projects", "app")
	in := []SandboxAllow{
		{Kind: "category", Value: "ssh", Project: proj},
		{Kind: "category", Value: "everything"},
		{Kind: "folder", Value: filepath.Join(proj, "logs"), Project: proj},
		{Kind: "folder", Value: home},
		{Kind: "folder", Value: filepath.Join(home, "Library", "LaunchAgents")},
		{Kind: "file", Value: filepath.Join(home, ".zshrc")},
		{Kind: "folder", Value: "relative/dir"},
		{Kind: "read", Value: filepath.Join(proj, ".env"), Project: proj},
		{Kind: "file", Value: filepath.Join(proj, "a\nb")},
		{Kind: "folder", Value: filepath.Join(proj, "x"), Project: "not/absolute"},
		{Kind: "shell", Value: "anything"},
	}
	got := normalizeSandboxAllow(in)
	want := []SandboxAllow{in[0], in[2], in[7]}
	if len(got) != len(want) {
		t.Fatalf("kept %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("kept %v, want %v", got, want)
		}
	}
}
