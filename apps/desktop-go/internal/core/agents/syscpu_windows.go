package agents

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetSystemTimes = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemTimes")

func ft(f windows.Filetime) float64 {
	return float64(uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime))
}

// SystemCPU：整机累计 CPU 时间（GetSystemTimes；内核时间里含空闲时间）
func SystemCPU() (busy, total float64, ok bool) {
	var idle, kernel, user windows.Filetime
	r, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)))
	if r == 0 {
		return 0, 0, false
	}
	total = ft(kernel) + ft(user)
	return total - ft(idle), total, true
}
