//go:build !windows

package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func realpathNative(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(r)
}

func hideWindow(*exec.Cmd) {}

func killTerm(p *os.Process) { _ = p.Signal(syscall.SIGTERM) }

func isJunctionInfo(os.FileInfo) bool { return false }
