//go:build windows

package igtools

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func setProcAttrs(cmd *exec.Cmd, sh ShellSpec, command string) {
	a := &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if sh.Verbatim {
		// windowsVerbatimArguments：命令行原样拼接
		a.CmdLine = syscallEscape(sh.File) + " " + strings.Join(sh.Args(command), " ")
	}
	cmd.SysProcAttr = a
}

func syscallEscape(s string) string { return syscall.EscapeArg(s) }

// killProcessTree（Windows：taskkill /T /F）
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	tk := exec.Command("taskkill", "/pid", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	tk.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if err := tk.Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}

func exitSignal(syscall.WaitStatus) string { return "" }

// CREATE_NO_WINDOW：不给控制台子进程建控制台窗口（只设 HideWindow 时，
// 默认终端是 Windows Terminal 的机器上仍会弹出窗口）
const createNoWindow = 0x08000000
