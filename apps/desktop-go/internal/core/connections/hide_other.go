//go:build !windows

package connections

import "os/exec"

func hideWindow(*exec.Cmd) {}
