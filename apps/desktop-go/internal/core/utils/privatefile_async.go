package utils

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
)

// 每个目标文件的写入队列（writeQueues）：同一路径的异步原子写按调用顺序串行。
var (
	writeMu     sync.Mutex
	writeQueues = map[string]chan struct{}{}
	writeIdle   = sync.NewCond(&writeMu)
	tmpSeq      int
)

// WritePrivateFileAtomicAsync = writePrivateFileAtomicAsync：各次写入用各自的临时文件
// `${file}.${pid}.${seq}.tmp`，失败时删掉临时文件再拒绝（message 与 Node fs 一致）。
func WritePrivateFileAtomicAsync(file string, data []byte) *jsrt.Promise[struct{}] {
	p := jsrt.NewPromise[struct{}]()
	writeMu.Lock()
	prev := writeQueues[file]
	tail := make(chan struct{})
	writeQueues[file] = tail
	writeMu.Unlock()
	go func() {
		if prev != nil {
			<-prev
		}
		writeMu.Lock()
		tmpSeq++
		tmp := fmt.Sprintf("%s.%d.%d.tmp", file, os.Getpid(), tmpSeq)
		writeMu.Unlock()
		err := writeAtomicNow(file, tmp, data)
		if err != nil {
			p.Reject(err)
		} else {
			p.Resolve(struct{}{})
		}
		writeMu.Lock()
		close(tail)
		if writeQueues[file] == tail {
			delete(writeQueues, file)
		}
		writeIdle.Broadcast()
		writeMu.Unlock()
	}()
	return p
}

func writeAtomicNow(file, tmp string, data []byte) error {
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		_ = os.Remove(tmp)
		return jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "open", tmp)}
	}
	if err := renameRetry(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "rename", tmp, file)}
	}
	_ = os.Chmod(file, 0o600)
	return nil
}

// WhenPrivateWritesIdle = whenPrivateWritesIdle（不管成败，等全部排队写入结束）。
func WhenPrivateWritesIdle() *jsrt.Promise[struct{}] {
	p := jsrt.NewPromise[struct{}]()
	go func() {
		writeMu.Lock()
		for len(writeQueues) > 0 {
			writeIdle.Wait()
		}
		writeMu.Unlock()
		p.Resolve(struct{}{})
	}()
	return p
}

// renameRetry = renameWithRetry：Windows 上 EPERM/EACCES/EBUSY 退避重试（约 2 秒预算）。
func renameRetry(from, to string) error {
	deadline := time.Now().Add(2 * time.Second)
	for delay := 10 * time.Millisecond; ; delay = min(delay*2, 100*time.Millisecond) {
		err := rename(from, to)
		if err == nil {
			return nil
		}
		c := nodefs.Code(err)
		if runtime.GOOS != "windows" || (c != "EPERM" && c != "EACCES" && c != "EBUSY") || time.Now().After(deadline) {
			return err
		}
		time.Sleep(delay)
	}
}

// WritePrivateFileAtomicNode = writePrivateFileAtomic 原样：`${file}.tmp`，不建目录，错误 message 同 Node fs。
func WritePrivateFileAtomicNode(file string, data []byte) error {
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "open", tmp)}
	}
	if err := renameRetry(tmp, file); err != nil {
		return jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "rename", tmp, file)}
	}
	_ = os.Chmod(file, 0o600)
	return nil
}

// rename：非 Windows 直接 rename(2)（os.Rename 对目标是目录先报 EEXIST；Node 是内核的 EISDIR 等）。
func rename(from, to string) error {
	if runtime.GOOS == "windows" {
		return os.Rename(from, to)
	}
	if err := syscall.Rename(from, to); err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	return nil
}
