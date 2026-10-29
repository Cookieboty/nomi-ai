//go:build !windows

package sandbox

import (
	"errors"
	"os"
	"syscall"
)

func lookupEnv(k string) (string, bool) { return os.LookupEnv(k) }

func signaled(st *os.ProcessState) bool {
	ws, ok := st.Sys().(syscall.WaitStatus)
	return ok && ws.Signaled()
}

func errnoOf(err error) syscall.Errno {
	var en syscall.Errno
	if errors.As(err, &en) {
		return en
	}
	if errors.Is(err, os.ErrNotExist) {
		return syscall.ENOENT
	}
	if errors.Is(err, os.ErrPermission) {
		return syscall.EACCES
	}
	return syscall.ENOENT
}

func errnoName(err error) string {
	switch errnoOf(err) {
	case syscall.EACCES:
		return "EACCES"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	}
	return "ENOENT"
}

func spawnErrorCode(err error) *int {
	c := -int(errnoOf(err))
	return &c
}

// withSpawnRequiredEnv：非 Windows 上 libuv 不补环境变量。
func withSpawnRequiredEnv(env []string) []string { return env }
