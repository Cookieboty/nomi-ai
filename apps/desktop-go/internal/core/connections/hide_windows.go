//go:build windows

package connections

import (
	"os/exec"
	"syscall"
)

// hideWindow：Windows 上不给子进程（gh）建控制台窗口，否则每次调用都会闪一下
func hideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
