// Package utils 对应 apps/desktop-electron/internal/core/src/utils（privateFile / coalescedWriter）。
package utils

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

// WritePrivateFileAtomic：写临时文件再 rename，权限 0600（对齐 writePrivateFileAtomic）。
// 临时文件名每次唯一（同进程并发保存同一路径也不会写进同一个临时文件），任何失败都删掉它。
// 同一路径多次保存的先后顺序由调用方保证（如 ConfigService 的 saveMu）。
// Windows 上不做 icacls（偏差 D12：Go 版跳过逐文件 ACL，依赖目录权限；userData 本身已是用户目录）。
func WritePrivateFileAtomic(path string, data []byte) (err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), fmt.Sprintf("%s.tmp-%d-*", filepath.Base(path), os.Getpid()))
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if err = f.Chmod(0o600); err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return renameWithRetry(tmp, path)
}

// rename 的重试参数与 Node 版相同（privateFile.ts renameWithRetry）
const renameRetryBudget = 2 * time.Second

var (
	renameFile = os.Rename                 // 单测注入
	isWindows  = runtime.GOOS == "windows" // 单测注入
)

// renameWithRetry = renameWithRetry：Windows 上目标文件正被别处短暂打开（杀软 / 索引器扫描、另一次替换同一路径）
// 时 MoveFileEx 会报 ACCESS_DENIED / SHARING_VIOLATION。这是瞬时占用：退避重试（10ms 起、单次最多 100ms、
// 总共 2 秒），超时仍失败才返回；正常写入一次成功，完全不等。其它平台与其它错误直接返回。
func renameWithRetry(from, to string) error {
	deadline := time.Now().Add(renameRetryBudget)
	for delay := 10 * time.Millisecond; ; delay = min(delay*2, 100*time.Millisecond) {
		err := renameFile(from, to)
		if err == nil || !isWindows || !transientRenameError(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(delay)
	}
}

// transientRenameError：Windows 的 ERROR_ACCESS_DENIED（映射为 fs.ErrPermission）、ERROR_SHARING_VIOLATION (32)、
// ERROR_LOCK_VIOLATION (33)，对应 Node 的 EPERM / EACCES / EBUSY
func transientRenameError(err error) bool {
	if errors.Is(err, fs.ErrPermission) {
		return true
	}
	var errno syscall.Errno
	return errors.As(err, &errno) && (errno == 32 || errno == 33)
}

// CoalescedWriter：同一时刻最多一个写入在跑、一个在排队（对齐 ConfigService 的 inflight/queued）。
type CoalescedWriter struct {
	mu       sync.Mutex
	inflight bool
	queued   bool
	write    func() error
}

func NewCoalescedWriter(write func() error) *CoalescedWriter {
	return &CoalescedWriter{write: write}
}

func (w *CoalescedWriter) Save() {
	w.mu.Lock()
	if w.inflight {
		w.queued = true
		w.mu.Unlock()
		return
	}
	w.inflight = true
	w.mu.Unlock()
	go w.loop()
}

func (w *CoalescedWriter) loop() {
	for {
		_ = w.write()
		w.mu.Lock()
		if !w.queued {
			w.inflight = false
			w.mu.Unlock()
			return
		}
		w.queued = false
		w.mu.Unlock()
	}
}

// WhenIdle 等当前写入结束（测试 / reload 用）
func (w *CoalescedWriter) WhenIdle() {
	for {
		w.mu.Lock()
		busy := w.inflight || w.queued
		w.mu.Unlock()
		if !busy {
			return
		}
	}
}

// WritePrivateFile = utils/privateFile.writePrivateFile（POSIX 0600；Windows ACL 见偏差 D12）
func WritePrivateFile(file, data string) error {
	if err := os.WriteFile(file, []byte(data), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	return nil
}
