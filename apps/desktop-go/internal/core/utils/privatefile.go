// Package utils 对应 packages/core/src/utils（privateFile / coalescedWriter）。
package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// WritePrivateFileAtomic：写临时文件再 rename，权限 0600（对齐 writePrivateFileAtomic）。
// Windows 上不做 icacls（偏差 D12：Go 版跳过逐文件 ACL，依赖目录权限；userData 本身已是用户目录）。
func WritePrivateFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
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
