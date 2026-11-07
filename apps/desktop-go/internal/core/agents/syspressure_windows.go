package agents

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// SystemMemory：Windows：GlobalMemoryStatusEx 的可用物理内存比例
func SystemMemory() MemPressure {
	m := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 || m.TotalPhys == 0 {
		return MemPressure{Level: PressureUnknown, AvailablePercent: -1}
	}
	avail := float64(m.AvailPhys) / float64(m.TotalPhys) * 100
	return MemPressure{Level: levelFromAvailable(avail), AvailablePercent: avail}
}
