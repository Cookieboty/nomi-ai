//go:build windows

package igtools

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func setProcAttrs(cmd *exec.Cmd, sh ShellSpec, command string) {
	a := &syscall.SysProcAttr{HideWindow: true}
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
	if err := exec.Command("taskkill", "/pid", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}

func exitSignal(syscall.WaitStatus) string { return "" }
