package sideterminal

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

type fakePTY struct {
	mu         sync.Mutex
	pr         *io.PipeReader
	pw         *io.PipeWriter
	writes     bytes.Buffer
	cols       uint16
	rows       uint16
	shell      string
	dir        string
	closed     bool
	closeCalls atomic.Int32
	exitCh     chan int
	waitErr    error
}

func newFakePTY(opts StartOptions) *fakePTY {
	pr, pw := io.Pipe()
	return &fakePTY{
		pr:     pr,
		pw:     pw,
		cols:   opts.Cols,
		rows:   opts.Rows,
		shell:  "zsh",
		dir:    opts.Dir,
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
	f.closeCalls.Add(1)
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

// waitWindowsStartup 等 ConPTY 的启动画面落地，并按需最小应答 shell/xterm 的查询。
// 只对实际见到的序列各应答一次：DA1（ESC[c / ESC[0c）、CPR（ESC[6n）、焦点事件（ESC[?1004h → ESC[I）。
// 同时等待“显示光标（ESC[?25h）或 OSC 标题”在之后出现、且其后 quiet 毫秒内没有新输出；
// 超时也不失败，只记录已经观察到的状态；后续 token 断言保持严格，由它给出 got= 失败信息。
func waitWindowsStartup(t *testing.T, mgr *Manager, id string, snapshot func() string, timeout, quiet time.Duration) {
	t.Helper()
	const (
		seenDA          = 1 << iota // ESC[c / ESC[0c
		seenCPR                     // ESC[6n
		seenFocusEvents             // ESC[?1004h，ConPTY 启动时默认开启
		seenPaint                   // ESC[?25h（显示光标）或 OSC 标题：启动画面已落地
	)
	seen := 0
	deadline := time.Now().Add(timeout)
	lastLen := -1
	var lastChange time.Time

	reply := func(seq, why string) {
		if !mgr.Write(id, seq) {
			t.Fatalf("real PTY reply to %s failed", why)
		}
	}

	for {
		got := snapshot()
		if len(got) != lastLen {
			lastLen = len(got)
			lastChange = time.Now()
			if seen&seenDA == 0 && (strings.Contains(got, "\x1b[c") || strings.Contains(got, "\x1b[0c")) {
				seen |= seenDA
				reply("\x1b[?61;4c", "DA1")
			}
			if seen&seenCPR == 0 && strings.Contains(got, "\x1b[6n") {
				seen |= seenCPR
				reply("\x1b[1;1R", "CPR")
			}
			if seen&seenFocusEvents == 0 && strings.Contains(got, "\x1b[?1004h") {
				seen |= seenFocusEvents
				reply("\x1b[I", "focus events")
			}
			if strings.Contains(got, "\x1b[?25h") || strings.Contains(got, "\x1b]0;") {
				seen |= seenPaint
			}
		}
		quietNow := time.Since(lastChange)
		if seen&seenPaint != 0 && quietNow >= quiet {
			return
		}
		if time.Now().After(deadline) {
			t.Logf("windows startup paint not confirmed within %s (seen bits=%04b, quiet=%s, bytes=%d); continuing", timeout, seen, quietNow, lastLen)
			return
		}
		time.Sleep(20 * time.Millisecond)
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

	snapshot := func() string {
		mu.Lock()
		defer mu.Unlock()
		return out.String()
	}

	token := "NOMI_SIDE_PTY_OK_9182"
	cmdLine := "echo " + token + " && exit 0\r"
	cmdDeadline := 6 * time.Second
	if runtime.GOOS == "windows" {
		// ConPTY 启动时先发一段 VT：清屏、隐藏光标、按尺寸重绘、OSC 标题、焦点事件与设备查询。
		// 产品里的 xterm.js 会应答这些查询；这里不是终端仿真器，所以只对实际见到的查询做最小应答，
		// 并等启动画面落地后再写命令，避免输入与启动重绘交叠。
		waitWindowsStartup(t, mgr, "real-1", snapshot, 5*time.Second, 300*time.Millisecond)
		cmdLine = "echo " + token + "\r\nexit 0\r\n"
		cmdDeadline = 8 * time.Second
	}
	if !mgr.Write("real-1", cmdLine) {
		t.Fatal("real PTY write failed")
	}

	deadline := time.Now().Add(cmdDeadline)
	found := false
	for time.Now().Before(deadline) {
		if strings.Contains(snapshot(), token) {
			found = true
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !found {
		got := snapshot()
		t.Fatalf("timed out waiting for token in real PTY output, sawPrompt=%t got=%q", strings.Contains(got, "PS "), got)
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

func TestReplayBufferCapacity256KB(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var fp *fakePTY
	var receivedBytes int

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		Emit: func(name string, data any) {
			if name != "sideTerminal.data" {
				return
			}
			m := data.(map[string]any)
			if b64, ok := m["data"].(string); ok {
				if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
					mu.Lock()
					receivedBytes += len(raw)
					mu.Unlock()
				}
			}
		},
		StartPTY: func(opts StartOptions) (PTY, error) {
			mu.Lock()
			defer mu.Unlock()
			fp = newFakePTY(opts)
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	res := mgr.OpenOwned(OpenInput{ID: "term-256k", Cols: 80, Rows: 24}, 1)
	if !res.OK {
		t.Fatalf("open failed: %+v", res)
	}

	head := "HEAD_MARKER_"
	tail := "_TAIL_MARKER"
	payloadLen := 128 * 1024 // 128KB，超过旧的 64KB 限制
	payload := make([]byte, payloadLen)
	for i := range payload {
		payload[i] = 'a'
	}
	copy(payload, head)
	copy(payload[len(payload)-len(tail):], tail)

	if _, err := fp.pw.Write(payload); err != nil {
		t.Fatalf("write payload failed: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := receivedBytes
		mu.Unlock()
		if n >= payloadLen {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	reused := mgr.OpenOwned(OpenInput{ID: "term-256k", Cols: 100, Rows: 30}, 2)
	if !reused.OK {
		t.Fatalf("reuse failed: %+v", reused)
	}
	rawReplay, err := base64.StdEncoding.DecodeString(reused.Replay)
	if err != nil {
		t.Fatalf("decode replay failed: %v", err)
	}
	if len(rawReplay) != payloadLen {
		t.Fatalf("expected replay length %d, got %d", payloadLen, len(rawReplay))
	}
	if !strings.HasPrefix(string(rawReplay), head) || !strings.HasSuffix(string(rawReplay), tail) {
		t.Fatalf("expected replay head and tail preserved")
	}
}

func TestManagerCloseCancelsInFlightStartupAndRecoversOnce(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	var created []*fakePTY

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		StartPTY: func(opts StartOptions) (PTY, error) {
			fp := newFakePTY(opts)
			mu.Lock()
			created = append(created, fp)
			idx := len(created)
			mu.Unlock()
			if idx == 1 {
				entered <- struct{}{}
				<-release
			}
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	openDone := make(chan OpenResult, 1)
	go func() {
		openDone <- mgr.OpenOwned(OpenInput{ID: "t-start", Cwd: dir, ExplicitCwd: true}, 1)
	}()

	<-entered
	// 启动过程中调用 Close 必须立即返回且不死锁，并作废在途启动
	if !mgr.Close("t-start") {
		t.Fatal("expected Close to cancel in-flight startup")
	}
	close(release)

	res := <-openDone
	if res.OK {
		t.Fatalf("cancelled startup should not succeed, got %+v", res)
	}
	if len(created) != 1 || created[0].closeCalls.Load() != 1 {
		t.Fatalf("expected in-flight fake PTY closed exactly once, got count=%d calls=%d", len(created), created[0].closeCalls.Load())
	}
	if mgr.Write("t-start", "echo nope\r") {
		t.Fatal("cancelled terminal must not accept writes")
	}

	// 再次打开可以恢复为健康可写会话
	res2 := mgr.OpenOwned(OpenInput{ID: "t-start", Cwd: dir, ExplicitCwd: true}, 1)
	if !res2.OK || res2.Generation < 2 {
		t.Fatalf("expected healthy reopen, got %+v", res2)
	}
	if !mgr.Write("t-start", "ok\r") {
		t.Fatal("expected reopened terminal to be writable")
	}
}

func TestManagerWindowCloseCancelsInFlightStartup(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	var created []*fakePTY

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		StartPTY: func(opts StartOptions) (PTY, error) {
			fp := newFakePTY(opts)
			mu.Lock()
			created = append(created, fp)
			mu.Unlock()
			entered <- struct{}{}
			<-release
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	ctx, cancel := context.WithCancel(context.Background())
	openDone := make(chan OpenResult, 1)
	go func() {
		openDone <- mgr.OpenOwnedContext(ctx, OpenInput{ID: "t-win", Cwd: dir, ExplicitCwd: true}, 77)
	}()

	<-entered
	cancel()
	mgr.CloseOwner(77)
	close(release)

	res := <-openDone
	if res.OK {
		t.Fatalf("expected window-closed open to fail, got %+v", res)
	}
	if len(created) != 1 || created[0].closeCalls.Load() != 1 {
		t.Fatalf("expected single close on cancelled window PTY, got %d", created[0].closeCalls.Load())
	}
}

func TestManagerRestartAndChangeDirInterleaving(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	dir3 := t.TempDir()

	var mu sync.Mutex
	var ptys []*fakePTY
	gate2Entered := make(chan struct{}, 1)
	gate2Release := make(chan struct{})
	gate3Entered := make(chan struct{}, 1)
	gate3Release := make(chan struct{})

	mgr := New(Deps{
		HomeDir: func() string { return dir1 },
		StartPTY: func(opts StartOptions) (PTY, error) {
			fp := newFakePTY(opts)
			mu.Lock()
			ptys = append(ptys, fp)
			mu.Unlock()
			switch opts.Dir {
			case dir2:
				gate2Entered <- struct{}{}
				<-gate2Release
			case dir3:
				gate3Entered <- struct{}{}
				<-gate3Release
			}
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	// 第 1 代会话在 dir1 启动
	r1 := mgr.Open(OpenInput{ID: "t-dir", Cwd: dir1, ExplicitCwd: true})
	if !r1.OK || r1.Generation != 1 || r1.Cwd != dir1 {
		t.Fatalf("unexpected r1: %+v", r1)
	}

	// 交错 1：发起 Replace 到 dir2（启动过程中先到），并发一次针对第 1 代的迟到 CloseGeneration
	r2Done := make(chan OpenResult, 1)
	go func() {
		r2Done <- mgr.Open(OpenInput{ID: "t-dir", Cwd: dir2, ExplicitCwd: true, Replace: true})
	}()
	<-gate2Entered
	// 迟到的旧代次关闭请求（gen=1）不得误杀正在启动的 gen=2
	if mgr.CloseGeneration("t-dir", r1.Generation) {
		t.Fatal("stale CloseGeneration(gen=1) must not cancel gen=2")
	}

	// 交错 2：dir2 尚未返回时又紧接着换目录到 dir3，且 dir3 先返回、dir2 后返回
	r3Done := make(chan OpenResult, 1)
	go func() {
		r3Done <- mgr.Open(OpenInput{ID: "t-dir", Cwd: dir3, ExplicitCwd: true, Replace: true})
	}()
	<-gate3Entered
	close(gate3Release)
	r3 := <-r3Done
	if !r3.OK || r3.Cwd != dir3 || r3.Generation <= r1.Generation {
		t.Fatalf("unexpected r3: %+v", r3)
	}

	// 再放行落后的 dir2：必须立刻失败并回收 dir2 的 PTY，绝不覆盖 dir3
	close(gate2Release)
	r2 := <-r2Done
	if r2.OK {
		t.Fatalf("superseded dir2 open should not win, got %+v", r2)
	}

	if !mgr.WriteGeneration("t-dir", "pwd\r", r3.Generation) {
		t.Fatal("expected final gen3 session to remain writable")
	}
	if mgr.WriteGeneration("t-dir", "stale\r", r1.Generation) {
		t.Fatal("stale generation write must be rejected")
	}
	if ptys[0].closeCalls.Load() != 1 || ptys[1].closeCalls.Load() != 1 || ptys[2].closeCalls.Load() != 0 {
		t.Fatalf("unexpected closeCounts: p1=%d p2=%d p3=%d",
			ptys[0].closeCalls.Load(), ptys[1].closeCalls.Load(), ptys[2].closeCalls.Load())
	}
	if !mgr.Close("t-dir") || ptys[2].closeCalls.Load() != 1 {
		t.Fatalf("final Close should reclaim p3 exactly once, got %d", ptys[2].closeCalls.Load())
	}
}

func TestManagerConcurrentOpenDeduplicatesAndSyncCancelsPending(t *testing.T) {
	dir := t.TempDir()
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var starts atomic.Int32
	var mu sync.Mutex
	var ptys []*fakePTY

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		StartPTY: func(opts StartOptions) (PTY, error) {
			n := starts.Add(1)
			fp := newFakePTY(opts)
			mu.Lock()
			ptys = append(ptys, fp)
			mu.Unlock()
			if n == 1 {
				entered <- struct{}{}
				<-release
			}
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	// 两个非替换并发 Open：只应启动 1 个 PTY，两者拿同一代次
	ch1 := make(chan OpenResult, 1)
	ch2 := make(chan OpenResult, 1)
	go func() { ch1 <- mgr.OpenOwned(OpenInput{ID: "dup", Cwd: dir, ExplicitCwd: true}, 5) }()
	<-entered
	go func() { ch2 <- mgr.OpenOwned(OpenInput{ID: "dup", Cwd: dir, ExplicitCwd: true}, 5) }()
	time.Sleep(15 * time.Millisecond)
	close(release)
	res1, res2 := <-ch1, <-ch2
	if !res1.OK || !res2.OK || res1.Generation != res2.Generation || starts.Load() != 1 {
		t.Fatalf("expected deduplicated open: res1=%+v res2=%+v starts=%d", res1, res2, starts.Load())
	}

	// 启动第二个终端时 Sync 空清单：运行中和启动中的均恰好回收 1 次
	release2 := make(chan struct{})
	mgr.deps.StartPTY = func(opts StartOptions) (PTY, error) {
		fp := newFakePTY(opts)
		mu.Lock()
		ptys = append(ptys, fp)
		mu.Unlock()
		entered <- struct{}{}
		<-release2
		return fp, nil
	}
	chPending := make(chan OpenResult, 1)
	go func() { chPending <- mgr.OpenOwned(OpenInput{ID: "pend", Cwd: dir, ExplicitCwd: true}, 5) }()
	<-entered
	closed := mgr.Sync(5, nil)
	close(release2)
	resPend := <-chPending
	if resPend.OK || len(closed) != 2 {
		t.Fatalf("expected Sync to close both live and pending, closed=%v resPend=%+v", closed, resPend)
	}
	for i, p := range ptys {
		if p.closeCalls.Load() != 1 {
			t.Fatalf("pty[%d] closeCalls=%d, want 1", i, p.closeCalls.Load())
		}
	}
}

func TestManagerGenerationAndByteOffsetsAcrossReplayAndLiveStream(t *testing.T) {
	dir := t.TempDir()
	var mu sync.Mutex
	var events []emittedEvent
	var fp *fakePTY

	mgr := New(Deps{
		HomeDir: func() string { return dir },
		Emit: func(name string, data any) {
			if name != "sideTerminal.data" {
				return
			}
			mu.Lock()
			events = append(events, emittedEvent{name: name, data: data.(map[string]any)})
			mu.Unlock()
		},
		StartPTY: func(opts StartOptions) (PTY, error) {
			fp = newFakePTY(opts)
			return fp, nil
		},
	})
	defer mgr.CloseAll()

	r1 := mgr.Open(OpenInput{ID: "off-1", Cwd: dir, ExplicitCwd: true})
	if !r1.OK || r1.Generation != 1 || r1.ReplayOffset == nil || *r1.ReplayOffset != 0 {
		t.Fatalf("unexpected initial open: %+v", r1)
	}

	// 段 1 与 段 2 字节内容完全相同（测试连续相同文本不能依赖启发式去重）
	seg1 := []byte("DUP_LINE\n中")
	if _, err := fp.pw.Write(seg1); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(events)
		mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	reused := mgr.Open(OpenInput{ID: "off-1"})
	if !reused.OK || reused.Generation != 1 || reused.ReplayOffset == nil || *reused.ReplayOffset != int64(len(seg1)) {
		t.Fatalf("unexpected reuse offsets: %+v (want %d)", reused, len(seg1))
	}

	// 段 2（同内容）和 段 3（增量）
	seg2 := []byte("DUP_LINE\n文")
	if _, err := fp.pw.Write(seg2); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	seg3 := []byte("TAIL_END\n")
	if _, err := fp.pw.Write(seg3); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		gotBytes := 0
		for _, ev := range events {
			raw, _ := base64.StdEncoding.DecodeString(ev.data["data"].(string))
			gotBytes += len(raw)
		}
		mu.Unlock()
		if gotBytes >= len(seg1)+len(seg2)+len(seg3) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	var rebuilt []byte
	var expectedOffset int64
	for _, ev := range events {
		if ev.data["generation"].(int64) != 1 {
			t.Fatalf("unexpected generation in data event: %+v", ev.data)
		}
		off := ev.data["offset"].(int64)
		if off != expectedOffset {
			t.Fatalf("non-contiguous offset: got %d, want %d", off, expectedOffset)
		}
		raw, _ := base64.StdEncoding.DecodeString(ev.data["data"].(string))
		rebuilt = append(rebuilt, raw...)
		expectedOffset += int64(len(raw))
	}
	mu.Unlock()
	if string(rebuilt) != string(seg1)+string(seg2)+string(seg3) {
		t.Fatalf("rebuilt mismatch: got %q", string(rebuilt))
	}

	// 验证超过 256KB 的 UTF-8 多字节文本溢出截断时首部不会残缺且末尾 ReplayOffset == totalBytes
	chunk := bytes.Repeat([]byte("汉"), 300*1024/3) // 300KB 多字节汉字，必然在 256KB 处跨字符切分
	// 故意错开 1 字节边界让 262144 落进汉字中间
	if _, err := fp.pw.Write(append([]byte{'X'}, chunk...)); err != nil {
		t.Fatal(err)
	}
	expectedTotal := int64(len(seg1)+len(seg2)+len(seg3)+1) + int64(len(chunk))
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap := mgr.Open(OpenInput{ID: "off-1"})
		if snap.ReplayOffset != nil && *snap.ReplayOffset == expectedTotal {
			raw, err := base64.StdEncoding.DecodeString(snap.Replay)
			if err != nil {
				t.Fatal(err)
			}
			if !utf8.Valid(raw) {
				t.Fatalf("truncated replay must trim orphaned leading UTF-8 continuation bytes")
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for total offset %d", expectedTotal)
}
