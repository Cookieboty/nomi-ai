//go:build !windows

package local

import "os/exec"

func hideWindow(*exec.Cmd) {}
