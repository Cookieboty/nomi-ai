//go:build !windows

package delegate

import "os/exec"

func hideWindow(*exec.Cmd) {}
