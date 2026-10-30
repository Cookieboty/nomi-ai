//go:build !windows

package igtools

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func setProcAttrs(cmd *exec.Cmd, _ ShellSpec, _ string) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}

func exitSignal(st syscall.WaitStatus) string {
	if !st.Signaled() {
		return ""
	}
	return unix.SignalName(st.Signal())
}
