package local

import "syscall"

func totalMem() uint64 {
	var i syscall.Sysinfo_t
	if syscall.Sysinfo(&i) != nil {
		return 0
	}
	return uint64(i.Totalram) * uint64(i.Unit)
}
