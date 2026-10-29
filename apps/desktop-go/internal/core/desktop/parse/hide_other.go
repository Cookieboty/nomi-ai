//go:build !windows

package parse

import "os/exec"

func hideWindow(*exec.Cmd) {}
