package desktop

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
)

// 跨文件系统移动（#191）：注入返回 EXDEV 的 rename，走复制 + 删源的分支

func withEXDEV(t *testing.T) *int {
	t.Helper()
	calls := 0
	orig := renameFS
	renameFS = func(from, to string) error {
		calls++
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: syscall.EXDEV}
	}
	t.Cleanup(func() { renameFS = orig })
	return &calls
}

func writeFile(t *testing.T, p, body string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func gone(p string) bool {
	_, err := os.Lstat(p)
	return errors.Is(err, os.ErrNotExist)
}

func TestTrashRegularFileAcrossDevices(t *testing.T) {
	calls := withEXDEV(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "ws", "note.txt")
	writeFile(t, src, "你好，回收站", 0o640)
	trash := NewAppTrash(filepath.Join(dir, "trash"), func() float64 { return 1_700_000_000_000 })

	rec, err := trash.Trash(src)
	if err != nil {
		t.Fatalf("Trash: %v", err)
	}
	if *calls != 1 {
		t.Fatalf("rename calls %d", *calls)
	}
	if !gone(src) {
		t.Fatal("源文件应在复制成功后移除")
	}
	if got := readFile(t, rec.Stored); got != "你好，回收站" {
		t.Fatalf("stored %q", got)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(rec.Stored)
		if st.Mode().Perm() != 0o640 {
			t.Fatalf("mode %v", st.Mode().Perm())
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(rec.Stored), "manifest.json")); err != nil {
		t.Fatalf("manifest: %v", err)
	}

	// 撤销（Restore）同样跨设备
	if err := trash.Restore(rec.Stored, rec.Original); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := readFile(t, src); got != "你好，回收站" || !gone(filepath.Dir(rec.Stored)) {
		t.Fatalf("restore %q", got)
	}
}

func TestMoveDirectoryAcrossDevices(t *testing.T) {
	withEXDEV(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "a")
	writeFile(t, filepath.Join(src, "x.txt"), "x", 0o644)
	writeFile(t, filepath.Join(src, "sub", "y.txt"), "yy", 0o644)
	dst := filepath.Join(dir, "b", "a")
	if err := MoveNoOverwrite(src, dst); err != nil {
		t.Fatalf("move: %v", err)
	}
	if !gone(src) || readFile(t, filepath.Join(dst, "x.txt")) != "x" || readFile(t, filepath.Join(dst, "sub", "y.txt")) != "yy" {
		t.Fatal("目录跨设备移动结果不对")
	}
}

func TestMoveAcrossDevicesTargetExists(t *testing.T) {
	withEXDEV(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	dst := filepath.Join(dir, "b.txt")
	writeFile(t, src, "new", 0o644)
	writeFile(t, dst, "old", 0o644)
	// MoveNoOverwrite 先判 conflict；moveFS 本身（Trash 路径）遇到已存在目标报 EEXIST
	var te *ToolError
	if err := MoveNoOverwrite(src, dst); !errors.As(err, &te) || te.Code != "conflict" {
		t.Fatalf("MoveNoOverwrite err %v", err)
	}
	if err := moveFS(src, dst); !errors.As(err, &te) || te.Code != "ERR_FS_CP_EEXIST" {
		t.Fatalf("moveFS err %v", err)
	}
	if readFile(t, src) != "new" || readFile(t, dst) != "old" {
		t.Fatal("失败时不得覆盖目标或删除源")
	}
}

func TestMoveFileAcrossDevicesCopyFailsMidway(t *testing.T) {
	withEXDEV(t)
	orig := copyData
	t.Cleanup(func() { copyData = orig })
	dir := t.TempDir()
	src := filepath.Join(dir, "big.bin")
	writeFile(t, src, "0123456789", 0o644)
	dst := filepath.Join(dir, "out", "big.bin")

	// 写出一半后报错
	copyData = func(w io.Writer, r io.Reader) (int64, error) {
		n, _ := io.CopyN(w, r, 4)
		return n, errors.New("disk full")
	}
	if err := MoveNoOverwrite(src, dst); err == nil || err.Error() != "disk full" {
		t.Fatalf("err %v", err)
	}
	if readFile(t, src) != "0123456789" || !gone(dst) {
		t.Fatal("中途失败应保留源并清理半截目标")
	}

	// 静默写短（无错误但字节数不符）也按失败处理
	copyData = func(w io.Writer, r io.Reader) (int64, error) { return io.CopyN(w, r, 4) }
	if err := MoveNoOverwrite(src, dst); err == nil {
		t.Fatal("short copy should fail")
	}
	if readFile(t, src) != "0123456789" || !gone(dst) {
		t.Fatal("写短应保留源并清理目标")
	}
}

func TestMoveFileAcrossDevicesUnreadableSource(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("权限位在 Windows / root 下不生效")
	}
	withEXDEV(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "secret.txt")
	writeFile(t, src, "s", 0o000)
	t.Cleanup(func() { _ = os.Chmod(src, 0o644) })
	dst := filepath.Join(dir, "out", "secret.txt")
	if err := MoveNoOverwrite(src, dst); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("err %v", err)
	}
	if gone(src) || !gone(dst) {
		t.Fatal("权限不足应保留源且不留目标")
	}
}

func TestMoveSymlinkAcrossDevices(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 建链接需要特权")
	}
	withEXDEV(t)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "real.txt"), "r", 0o644)
	src := filepath.Join(dir, "ws", "link")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../real.txt", src); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "out", "link")
	if err := MoveNoOverwrite(src, dst); err != nil {
		t.Fatalf("move: %v", err)
	}
	// 与 fs.cp 默认一致：复制链接本身，相对目标解析为绝对路径
	got, err := os.Readlink(dst)
	if err != nil || got != filepath.Join(dir, "real.txt") || !gone(src) {
		t.Fatalf("link %q err %v", got, err)
	}
}

func TestMoveSameDeviceUsesRename(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	writeFile(t, src, "a", 0o644)
	called := 0
	orig := copyData
	copyData = func(w io.Writer, r io.Reader) (int64, error) { called++; return io.Copy(w, r) }
	t.Cleanup(func() { copyData = orig })
	if err := MoveNoOverwrite(src, filepath.Join(dir, "b", "a.txt")); err != nil {
		t.Fatal(err)
	}
	if called != 0 || !gone(src) || readFile(t, filepath.Join(dir, "b", "a.txt")) != "a" {
		t.Fatal("同设备应直接 rename")
	}
}
