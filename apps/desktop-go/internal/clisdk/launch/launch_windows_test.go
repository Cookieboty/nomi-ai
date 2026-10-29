//go:build windows

package launch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Windows 金标（按 Node/libuv 文档逻辑的夹具）：目录共享用 junction（无需特权）；libuv 写入的
// SubstituteName/PrintName 以 \ 结尾，因此 readlinkSync 返回 target+`\`，与 target 不等 → 每次启动都删后重建（行为同 Node）。
func TestJunctionParityWindows(t *testing.T) {
	S, err := realpathNative(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(S, "user", "dir")
	if err := os.MkdirAll(target, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "x.txt"), []byte("hi"), 0o666); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(S, "home", "dir")
	for i := 0; i < 2; i++ {
		if r := LinkShared(target, link, true, "win32"); r != "" {
			t.Fatalf("round %d: %s", i, r)
		}
		st, err := os.Lstat(link)
		if err != nil || !isLink(st) {
			t.Fatalf("round %d: not a link: %v %v", i, st, err)
		}
		to, err := readlinkNode(link)
		if err != nil || to != target+`\` {
			t.Fatalf("readlink = %q %v, want %q", to, err, target+`\`)
		}
		b, err := os.ReadFile(filepath.Join(link, "x.txt"))
		if err != nil || string(b) != "hi" {
			t.Fatalf("read through junction: %q %v", b, err)
		}
	}
	// canonicalDir 经 realpath.native（GetFinalPathNameByHandle）穿过 junction，缺失尾段原样拼回、去尾分隔符
	if g, w := CanonicalDir(link+`\missing\deeper\`), filepath.Join(target, "missing", "deeper"); g != w {
		t.Fatalf("canonicalDir = %q want %q", g, w)
	}
	if g := CanonicalDir(target + `/`); g != target {
		t.Fatalf("canonicalDir = %q want %q", g, target)
	}
	// 真实目录保留不动
	real := filepath.Join(S, "home", "real")
	_ = os.MkdirAll(real, 0o777)
	if r := LinkShared(target, real, true, "win32"); r != "" {
		t.Fatal(r)
	}
	if st, _ := os.Lstat(real); isLink(st) {
		t.Fatal("real dir replaced")
	}
	// 文件软链：无特权/开发者模式时 Node 报 "EPERM: operation not permitted, symlink 'a' -> 'b'"
	f := filepath.Join(S, "user", "f.txt")
	_ = os.WriteFile(f, []byte("u"), 0o666)
	fl := filepath.Join(S, "home", "f.txt")
	if r := LinkShared(f, fl, false, "win32"); r != "" {
		want := "EPERM: operation not permitted, symlink '" + f + "' -> '" + fl + "'"
		if r != want {
			t.Fatalf("file symlink error %q want %q", r, want)
		}
	}
	// 父路径是文件 → EEXIST, mkdir '<dirname>'
	blk := filepath.Join(S, "blocker")
	_ = os.WriteFile(blk, nil, 0o666)
	if r := LinkShared(f, filepath.Join(blk, "x"), false, "win32"); r != "EEXIST: file already exists, mkdir '"+blk+"'" {
		t.Fatalf("blocker: %q", r)
	}
	if !strings.HasPrefix(S, `\\`) && len(S) > 1 && S[1] != ':' {
		t.Fatalf("realpath not DOS form: %q", S)
	}
}
