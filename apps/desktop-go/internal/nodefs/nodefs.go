// Package nodefs 把 Go 文件系统错误翻译成 Node（libuv）的错误码与 Error.message，
// 各平台共用（Windows 的 Win32 错误按 uv_translate_sys_error 映射），供所有移植代码复刻 Node 文案。
package nodefs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"syscall"
	"time"
)

// UvDesc：libuv uv_strerror 文案。
var UvDesc = map[string]string{
	"EEXIST": "file already exists", "EPERM": "operation not permitted", "EACCES": "permission denied",
	"ENOENT": "no such file or directory", "ENOTDIR": "not a directory", "EROFS": "read-only file system",
	"EISDIR": "illegal operation on a directory", "ENOSPC": "no space left on device", "EINVAL": "invalid argument",
	"ELOOP": "too many symbolic links encountered", "ENAMETOOLONG": "name too long", "EBUSY": "resource busy or locked",
	"ENOTEMPTY": "directory not empty", "EIO": "i/o error", "UNKNOWN": "unknown error",
}

// Code = Node err.code（libuv 名）。
func Code(err error) string {
	var en syscall.Errno
	if errors.As(err, &en) {
		if c := errnoName(en); c != "" {
			return c
		}
	}
	switch {
	case errors.Is(err, fs.ErrExist):
		return "EEXIST"
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrPermission):
		return "EPERM"
	}
	return "UNKNOWN"
}

// Message = Node fs 同步调用的 Error.message：`CODE: desc, syscall 'path'[ -> 'dest']`；path "" 时省略路径。
func Message(err error, syscallName, path string, dest ...string) string {
	c := Code(err)
	m := fmt.Sprintf("%s: %s, %s", c, UvDesc[c], syscallName)
	if path != "" {
		m += fmt.Sprintf(" '%s'", path)
	}
	if len(dest) > 0 {
		m += fmt.Sprintf(" -> '%s'", dest[0])
	}
	return m
}

// ReadFileError = fs.readFileSync(p) 抛出的 message：open 阶段带路径；读目录是 read 阶段（EISDIR，无路径）。
func ReadFileError(err error, p string) string {
	if Code(err) == "EISDIR" {
		return Message(err, "read", "")
	}
	return Message(err, "open", p)
}

// RmForce = fs.rmSync(p, {recursive:true, force:true})，错误被吞（调用方本就 try/catch）。
// Windows：刚被 kill 的子进程仍以该目录为 cwd 时句柄释放有延迟，Node 的 TerminateProcess 是同步的；
// 这里对共享冲突 / 拒绝访问短暂重试（≤1s）以得到与 Node 相同的结果。
func RmForce(p string) error {
	err := os.RemoveAll(p)
	if runtime.GOOS != "windows" {
		return err
	}
	for i := 0; err != nil && i < 20; i++ {
		c := Code(err)
		if c != "EBUSY" && c != "EPERM" && c != "ENOTEMPTY" {
			break
		}
		time.Sleep(50 * time.Millisecond)
		err = os.RemoveAll(p)
	}
	return err
}
