//go:build !windows

package local

import (
	"os"
	"os/exec"
	"syscall"
)

func hideWindow(*exec.Cmd) {}

// terminate = ChildProcess.kill()（默认 SIGTERM）
func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
