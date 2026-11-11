package computer

import "testing"

func TestResponsibleApp(t *testing.T) {
	if got := responsibleApp("/Applications/Nomi.app/Contents/MacOS/nomi", 100, nil); got != "Nomi" {
		t.Fatal(got)
	}
	// 开发版：裸二进制，往上找到终端
	chain := map[int]struct {
		ppid int
		comm string
	}{
		100: {90, "node"}, 90: {80, "/bin/zsh"}, 80: {70, "/usr/bin/login"},
		70: {1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"},
	}
	parent := func(pid int) (int, string) {
		c := chain[pid]
		return c.ppid, c.comm
	}
	if got := responsibleApp("/repo/build/bin/nomi", 100, parent); got != "Ghostty" {
		t.Fatal(got)
	}
	if got := responsibleApp("/repo/build/bin/nomi", 100, func(int) (int, string) { return 1, "launchd" }); got != "" {
		t.Fatal(got)
	}
}
