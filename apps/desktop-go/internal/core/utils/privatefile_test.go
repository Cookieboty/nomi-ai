package utils

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// #182：同进程并发保存同一路径，各自用唯一临时文件：全部成功、最终内容是某一份完整快照、无临时文件残留
func TestWritePrivateFileAtomicConcurrent(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.json")
	bodies := make([]string, 16)
	for i := range bodies {
		bodies[i] = `{"n":"` + strings.Repeat(string(rune('a'+i)), 1+i*4096) + `"}`
	}
	var wg sync.WaitGroup
	errs := make([]error, len(bodies))
	for i := range bodies {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for range 20 {
				if err := WritePrivateFileAtomic(p, []byte(bodies[i])); err != nil {
					errs[i] = err
					return
				}
			}
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("writer %d: %v", i, err)
		}
	}
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	ok := false
	for _, b := range bodies {
		ok = ok || string(got) == b
	}
	if !ok {
		t.Fatalf("内容不是任何一份完整快照（%d 字节）", len(got))
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", st.Mode().Perm())
		}
	}
	assertNoTmp(t, dir)
}

// rename 失败（目标是非空目录）时报错并删掉临时文件
func TestWritePrivateFileAtomicCleansTmpOnFailure(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.json")
	if err := os.MkdirAll(filepath.Join(p, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateFileAtomic(p, []byte("{}")); err == nil {
		t.Fatal("目标是非空目录时应失败")
	}
	assertNoTmp(t, dir)
}

func assertNoTmp(t *testing.T, dir string) {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".tmp") {
			t.Fatalf("临时文件残留: %s", e.Name())
		}
	}
}

// Windows 上替换时目标被短暂占用（ACCESS_DENIED）：退避重试直到成功；非瞬时错误直接返回（同 Node renameWithRetry）
func TestRenameWithRetry(t *testing.T) {
	origRename, origWin := renameFile, isWindows
	t.Cleanup(func() { renameFile, isWindows = origRename, origWin })
	isWindows = true
	calls := 0
	renameFile = func(from, to string) error {
		calls++
		if calls < 3 {
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: fs.ErrPermission}
		}
		return nil
	}
	if err := renameWithRetry("a", "b"); err != nil || calls != 3 {
		t.Fatalf("transient: err=%v calls=%d", err, calls)
	}
	calls = 0
	renameFile = func(from, to string) error {
		calls++
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: fs.ErrNotExist}
	}
	if err := renameWithRetry("a", "b"); err == nil || calls != 1 {
		t.Fatalf("non-transient: err=%v calls=%d", err, calls)
	}
	isWindows, calls = false, 0
	renameFile = func(from, to string) error {
		calls++
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: fs.ErrPermission}
	}
	if err := renameWithRetry("a", "b"); err == nil || calls != 1 {
		t.Fatalf("non-windows: err=%v calls=%d", err, calls)
	}
}
