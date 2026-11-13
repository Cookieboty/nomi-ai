//go:build windows

package computer

import (
	"os"
	"os/exec"
	"syscall"
)

func hideWindow(c *exec.Cmd) {
	if isBatchFile(c.Path) {
		// .cmd / .bat 由 cmd.exe 解释。自己把垫片交给带 CREATE_NO_WINDOW 的 cmd.exe，
		// 否则 Windows 拉起的控制台宿主仍会弹出窗口。
		comspec := os.Getenv("ComSpec")
		if comspec == "" {
			comspec = `C:\Windows\System32\cmd.exe`
		}
		path, argv, line := windowsBatchLaunch(comspec, c.Path, c.Args[1:])
		c.Path = path
		c.Args = argv
		c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow, CmdLine: line}
		return
	}
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// CREATE_NO_WINDOW：不给控制台子进程建控制台窗口（只设 HideWindow 时，
// 默认终端是 Windows Terminal 的机器上仍会弹出窗口）
const createNoWindow = 0x08000000
