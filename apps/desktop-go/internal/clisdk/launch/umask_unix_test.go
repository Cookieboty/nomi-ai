//go:build !windows

package launch

import "syscall"

func setUmask(m int) func() {
	old := syscall.Umask(m)
	return func() { syscall.Umask(old) }
}
