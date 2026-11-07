//go:build !windows

package harness

import "syscall"

// suspendPid / resumePid：冻结 / 恢复一个进程（SIGSTOP / SIGCONT）
func suspendPid(pid int) error { return syscall.Kill(pid, syscall.SIGSTOP) }
func resumePid(pid int) error  { return syscall.Kill(pid, syscall.SIGCONT) }
