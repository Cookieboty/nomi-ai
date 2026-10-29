package local

import "golang.org/x/sys/unix"

func totalMem() uint64 {
	v, _ := unix.SysctlUint64("hw.memsize")
	return v
}
