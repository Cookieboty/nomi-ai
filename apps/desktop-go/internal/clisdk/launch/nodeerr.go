package launch

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// uvDesc：libuv uv_strerror 文案（Node 的 e.message 前半段）。
var uvDesc = map[string]string{
	"EEXIST": "file already exists", "EPERM": "operation not permitted", "EACCES": "permission denied",
	"ENOENT": "no such file or directory", "ENOTDIR": "not a directory", "EROFS": "read-only file system",
	"EISDIR": "illegal operation on a directory", "ENOSPC": "no space left on device", "EINVAL": "invalid argument",
	"ELOOP": "too many symbolic links encountered", "ENAMETOOLONG": "name too long", "EBUSY": "resource busy or locked",
	"EIO": "i/o error", "UNKNOWN": "unknown error",
}

// errCode 把 Go 错误翻译成 libuv 错误码名（平台映射见 errno_{unix,windows}.go）。
func errCode(err error) string {
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

// nodeErrMessage 复刻 Node fs 同步调用抛出的 Error.message：`CODE: desc, syscall 'path'[ -> 'dest']`。
func nodeErrMessage(err error, syscallName, path string, dest ...string) string {
	c := errCode(err)
	m := fmt.Sprintf("%s: %s, %s '%s'", c, uvDesc[c], syscallName, path)
	if len(dest) > 0 {
		m += fmt.Sprintf(" -> '%s'", dest[0])
	}
	return m
}

var _ = os.ErrExist

// NodeErrMessage = nodeErrMessage（供其它包复刻 Node fs 同步错误文案）。
func NodeErrMessage(err error, syscallName, path string, dest ...string) string {
	return nodeErrMessage(err, syscallName, path, dest...)
}
