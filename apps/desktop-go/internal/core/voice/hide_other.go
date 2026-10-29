//go:build !windows

package voice

import "os/exec"

func hideWindow(*exec.Cmd) {}
