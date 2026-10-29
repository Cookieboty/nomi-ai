//go:build !windows

package accounts

import (
	"errors"
	"syscall"
)

func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
