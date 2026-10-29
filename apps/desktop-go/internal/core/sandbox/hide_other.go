//go:build !windows

package sandbox

import "os/exec"

func hideWindow(*exec.Cmd) {}
