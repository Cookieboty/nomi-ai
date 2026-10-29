//go:build !windows

package usage

import (
	"os"
	"syscall"
)

func pidAlive(p int) bool {
	pr, err := os.FindProcess(p)
	if err != nil {
		return false
	}
	return pr.Signal(syscall.Signal(0)) == nil
}
