//go:build !windows

package terminal

import "os/exec"

func hideWindow(*exec.Cmd) {}
