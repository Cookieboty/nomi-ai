package parse

import (
	"os/exec"
	"syscall"
)

func hideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// CREATE_NO_WINDOW：不给控制台子进程建控制台窗口（只设 HideWindow 时，
// 默认终端是 Windows Terminal 的机器上仍会弹出窗口）
const createNoWindow = 0x08000000
