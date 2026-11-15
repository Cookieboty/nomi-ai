package devviews

import (
	"errors"
	"reflect"
	"strings"
	"syscall"
)

// Windows Sockets 错误码。标准库的 syscall.ECONNRESET / ECONNREFUSED 在 Windows
// 上并不是这些值，所以按数字认，syscall.Errno 和 windows.Errno 都算。
const (
	wsaEconnAborted uintptr = 10053
	wsaEconnReset   uintptr = 10054
	wsaEconnRefused uintptr = 10061
)

func isWSATransient(err error) bool {
	if isWindowsConnErrno(err) {
		return true
	}
	for e := err; e != nil; e = errors.Unwrap(e) {
		n, ok := errnoNumber(e)
		if ok && (n == wsaEconnReset || n == wsaEconnRefused || n == wsaEconnAborted) {
			return true
		}
	}
	msg := err.Error()
	return strings.Contains(msg, "An existing connection was forcibly closed by the remote host") ||
		strings.Contains(msg, "An established connection was aborted by the software in your host machine") ||
		strings.Contains(msg, "No connection could be made because the target machine actively refused it")
}

// errnoNumber 取出 syscall.Errno 或 golang.org/x/sys/windows.Errno 的错误码。
// 两者都是名为 Errno 的 uintptr，但不是同一个类型时 errors.Is 对不上。
func errnoNumber(err error) (uintptr, bool) {
	if e, ok := err.(syscall.Errno); ok {
		return uintptr(e), true
	}
	rv := reflect.ValueOf(err)
	if !rv.IsValid() || rv.Kind() != reflect.Uintptr {
		return 0, false
	}
	t := rv.Type()
	if t.Name() != "Errno" {
		return 0, false
	}
	switch t.PkgPath() {
	case "syscall", "golang.org/x/sys/windows":
		return uintptr(rv.Uint()), true
	default:
		return 0, false
	}
}
