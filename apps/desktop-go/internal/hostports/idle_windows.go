//go:build windows

package hostports

import (
	"syscall"
	"unsafe"
)

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	pGetLastInputInfo = user32.NewProc("GetLastInputInfo")
	pGetTickCount     = kernel32.NewProc("GetTickCount")
)

type lastInputInfo struct {
	cbSize uint32
	dwTime uint32
}

// IdleSeconds = powerMonitor.getSystemIdleTime（Chromium 在 Windows 上同样用 GetLastInputInfo）
func IdleSeconds() int {
	li := lastInputInfo{cbSize: uint32(unsafe.Sizeof(lastInputInfo{}))}
	if r, _, _ := pGetLastInputInfo.Call(uintptr(unsafe.Pointer(&li))); r == 0 {
		return 0
	}
	now, _, _ := pGetTickCount.Call()
	return int((uint32(now) - li.dwTime) / 1000)
}
