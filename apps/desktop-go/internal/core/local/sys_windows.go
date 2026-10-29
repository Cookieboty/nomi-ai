//go:build windows

package local

import (
	"os/exec"
	"syscall"
)

func hideWindow(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func totalMem() uint64 { return 8 << 30 } // TODO(win): GlobalMemoryStatusEx
