//go:build !windows

package cli

import "syscall"

var sigterm = syscall.SIGTERM
