package sideterminal

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakePTY struct {
	mu      sync.Mutex
	pr      *io.PipeReader
	pw      *io.PipeWriter
	writes  bytes.Buffer
	cols    uint16
	rows    uint16
	shell   string
	closed  bool
	exitCh  chan int
	waitErr error
}

func newFakePTY(opts StartOptions) *fakePTY {
	pr, pw := io.Pipe()
	return &fakePTY{
		pr:     pr,
		pw:     pw,
		cols:   opts.Cols,
		rows:   opts.Rows,
		shell:  "zsh",
		exitCh: make(chan int, 1),
	}
}

func (f *fakePTY) Read(p []byte) (int, error) { return f.pr.Read(p) }
func (f *fakePTY) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, os.ErrClosed
	}
	return f.writes.Write(p)
}
func (f *fakePTY) Resize(cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cols, f.rows = cols, rows
	return nil
}
func (f *fakePTY) Wait() (int, string, error) {
	code := <-f.exitCh
	_ = f.pw.Close()
	return code, "", f.waitErr
}
func (f *fakePTY) Close() error {
	f.mu.Lock()
	wasClosed := f.closed
	f.closed = true
	f.mu.Unlock()
	if !wasClosed {
		_ = f.pw.Close()
		_ = f.pr.Close()
		select {
		case f.exitCh <- 0:
		default:
		}
	}
	return nil
}
func (f *fakePTY) Shell() string { return f.shell }

type emittedEvent struct {
	name string
	data map[string]any
}

func TestResolveDirPriorityAndDeny(t *testing.T) {
	tmp := t.TempDir()
	primaryDir := filepath.Join(tmp, "project-primary")
	worktreeDir := filepath.Join(tmp, "project-worktree")
	otherDir := filepath.Join(tmp, "other-dir")
	deniedDir := filepath.Join(tmp, "secret-dir")
	homeDir := filepath.Join(tmp, "home")
	for _, d := range []string{primaryDir, worktreeDir, otherDir, deniedDir, homeDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	var gotOpts []StartOptions
	mgr := New(Deps{
		ProjectPrimary: func(projectID string) string {
			if projectID == "proj-1" {
				return primaryDir
			}
			return ""
		},
		FindProjectPrimary: func(dir string) string {
			if dir == worktreeDir {
				return primaryDir
			}
			return ""
		},
		IsDeniedDir: func(dir string) string {
			if dir == deniedDir {
				return "protected"
			}
			return ""
		},
		HomeDir: func() string { return homeDir },
		StartPTY: func(opts StartOptions) (PTY, error) {
			gotOpts = append(gotOpts, opts)
			return newFakePTY(opts), nil
		},
	})
	defer mgr.CloseAll()

	// 1. 有 projectId 且传了 worktree cwd 时，仍默认打开主工程主文件夹
	res := mgr.Open(OpenInput{ID: "t1", ProjectID: "proj-1", Cwd: worktreeDir, Cols: 100, Rows: 30})
	if !res.OK || res.Cwd != primaryDir {
		t.Fatalf("expected primaryDir %q, got ok=%v cwd=%q", primaryDir, res.OK, res.Cwd)
	}

	// 2. 无 projectId 但 cwd 在某个项目范围内，反查主工程主文件夹
	res = mgr.Open(OpenInput{ID: "t2", Cwd: worktreeDir})
	if !res.OK || res.Cwd != primaryDir {
		t.Fatalf("expected resolved primaryDir %q, got ok=%v cwd=%q", primaryDir, res.OK, res.Cwd)
	}

	// 3. explicitCwd=true 时尊重用户主动指定的目录（不被 projectId 覆盖）
	res = mgr.Open(OpenInput{ID: "t3", ProjectID: "proj-1", Cwd: otherDir, ExplicitCwd: true})
	if !res.OK || res.Cwd != otherDir {
		t.Fatalf("expected explicit otherDir %q, got ok=%v cwd=%q", otherDir, res.OK, res.Cwd)
	}

	// 4. explicitCwd 命中受保护目录时拒绝并返回 denied
	res = mgr.Open(OpenInput{ID: "t4", Cwd: deniedDir, ExplicitCwd: true})
	if res.OK || res.Reason == nil || *res.Reason != "denied" {
		t.Fatalf("expected denied reason, got %+v", res)
	}

	// 5. 无项目且无 cwd 时回退到用户主目录
	res = mgr.Open(OpenInput{ID: "t5"})
	if !res.OK || res.Cwd != homeDir {
		t.Fatalf("expected homeDir fallback %q, got ok=%v cwd=%q", homeDir, res.OK, res.Cwd)
	}

	if len(gotOpts) != 4 || gotOpts[0].Cols != 100 || gotOpts[0].Rows != 30 {
		t.Fatalf("unexpected start options: %+v", gotOpts)
	}
}

func TestManagerLifecycleReplaySyncAndOwnerCleanup(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var events []emittedEvent
	fakes := map[string]*fakePTY{}

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		Emit: func(name string, data any) {
			mu.Lock()
			defer mu.Unlock()
			events = append(events, emittedEvent{name: name, data: data.(map[string]any)})
		},
		StartPTY: func(opts StartOptions) (PTY, error) {
			fp := newFakePTY(opts)
			mu.Lock()
			fakes[fmt.Sprintf("p%d", len(fakes))] = fp
			mu.Unlock()
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	r1 := mgr.OpenOwned(OpenInput{ID: "term-a", Cols: 80, Rows: 24}, 10)
	if !r1.OK {
		t.Fatalf("open failed: %+v", r1)
	}
	var fp *fakePTY
	mu.Lock()
	fp = fakes["p0"]
	mu.Unlock()

	// 写入终端输出，验证合帧推送 + 复用回放
	_, _ = fp.pw.Write([]byte("hello terminal\r\n"))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(events)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	reused := mgr.OpenOwned(OpenInput{ID: "term-a", Cols: 120, Rows: 40}, 11)
	if !reused.OK {
		t.Fatalf("reuse failed: %+v", reused)
	}
	rawReplay, err := base64.StdEncoding.DecodeString(reused.Replay)
	if err != nil || !strings.Contains(string(rawReplay), "hello terminal") {
		t.Fatalf("expected replay containing hello terminal, got %q err=%v", string(rawReplay), err)
	}
	fp.mu.Lock()
	cols, rows := fp.cols, fp.rows
	fp.mu.Unlock()
	if cols != 120 || rows != 40 {
		t.Fatalf("expected resized to 120x40, got %dx%d", cols, rows)
	}

	if !mgr.Write("term-a", "pwd\r") {
		t.Fatal("expected Write to return true")
	}
	fp.mu.Lock()
	written := fp.writes.String()
	fp.mu.Unlock()
	if written != "pwd\r" {
		t.Fatalf("expected writes=pwd\\r, got %q", written)
	}

	// 新打开属于 owner 12 的会话与另外一个属于 owner 11 的会话，测试 Sync 只清 owner 11 不在清单中的项
	_ = mgr.OpenOwned(OpenInput{ID: "term-b"}, 11)
	_ = mgr.OpenOwned(OpenInput{ID: "term-c"}, 12)
	closed := mgr.Sync(11, []string{"term-b"})
	if len(closed) != 1 || closed[0] != "term-a" {
		t.Fatalf("expected [term-a] synced closed, got %v", closed)
	}

	// CloseOwner 只清 owner 12，不影响 owner 11
	mgr.CloseOwner(12)
	if !mgr.Write("term-b", "x") {
		t.Fatal("term-b should still be open")
	}
	if mgr.Write("term-c", "x") {
		t.Fatal("term-c should be closed")
	}
}

func TestManagerLimit(t *testing.T) {
	dir := t.TempDir()
	mgr := New(Deps{
		HomeDir: func() string { return dir },
		StartPTY: func(opts StartOptions) (PTY, error) {
			return newFakePTY(opts), nil
		},
	})
	defer mgr.CloseAll()

	for i := 0; i < maxTerminals; i++ {
		res := mgr.Open(OpenInput{ID: fmt.Sprintf("t-%d", i)})
		if !res.OK {
			t.Fatalf("failed at %d: %+v", i, res)
		}
	}
	over := mgr.Open(OpenInput{ID: "over-limit"})
	if over.OK || over.Reason == nil || *over.Reason != "limit" {
		t.Fatalf("expected limit error, got %+v", over)
	}
}

func TestRealPTYReadWriteAndClose(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("unsupported OS")
	}
	dir := t.TempDir()
	var mu sync.Mutex
	var out bytes.Buffer
	exitCh := make(chan int, 1)

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		Emit: func(name string, data any) {
			m := data.(map[string]any)
			switch name {
			case "sideTerminal.data":
				if b64, ok := m["data"].(string); ok {
					if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
						mu.Lock()
						out.Write(raw)
						mu.Unlock()
					}
				}
			case "sideTerminal.exit":
				code := -1
				if c, ok := m["exitCode"].(int); ok {
					code = c
				}
				select {
				case exitCh <- code:
				default:
				}
			}
		},
	})
	defer mgr.CloseAll()

	res := mgr.Open(OpenInput{ID: "real-1", Cwd: dir, ExplicitCwd: true, Cols: 80, Rows: 24})
	if !res.OK {
		t.Fatalf("real PTY open failed: %+v", res)
	}
	if !mgr.Resize("real-1", 100, 32) {
		t.Fatal("real PTY resize failed")
	}

	token := "NOMI_SIDE_PTY_OK_9182"
	cmdLine := "echo " + token + " && exit 0\r"
	if runtime.GOOS == "windows" {
		cmdLine = "echo " + token + "\r\nexit 0\r\n"
	}
	if !mgr.Write("real-1", cmdLine) {
		t.Fatal("real PTY write failed")
	}

	deadline := time.Now().Add(6 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		mu.Lock()
		got := out.String()
		mu.Unlock()
		if strings.Contains(got, token) {
			found = true
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !found {
		mu.Lock()
		got := out.String()
		mu.Unlock()
		t.Fatalf("timed out waiting for token in real PTY output, got=%q", got)
	}

	select {
	case <-exitCh:
	case <-time.After(6 * time.Second):
		// 部分交互 shell 配置可能不立刻随 exit 0 关闭，手动 Close 验证不挂起即可
		if !mgr.Close("real-1") {
			t.Fatal("expected Close to return true")
		}
	}
}
