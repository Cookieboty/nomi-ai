//go:build windows

package delegate

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW：不给 git 建控制台窗口（只设 HideWindow 时，默认终端是 Windows Terminal 的机器上仍会弹出窗口）
const createNoWindow = 0x08000000

func hideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
