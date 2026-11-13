//go:build !windows

package computer

import "os/exec"

func hideWindow(*exec.Cmd) {}
