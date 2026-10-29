//go:build !windows

package extensions

import "syscall"

const oNoFollow = syscall.O_NOFOLLOW
