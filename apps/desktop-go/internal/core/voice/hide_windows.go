//go:build windows

package voice

import (
	"os/exec"
	"syscall"
)

// windowsHide: true
func hideWindow(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
