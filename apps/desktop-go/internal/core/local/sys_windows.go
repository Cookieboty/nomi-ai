//go:build windows

package local

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

func hideWindow(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

// terminate = ChildProcess.kill()：libuv 在 Windows 上对任何信号都直接 TerminateProcess
func terminate(p *os.Process) error { return p.Kill() }

var procGlobalMemoryStatusEx = syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

// memoryStatusEx = MEMORYSTATUSEX
type memoryStatusEx struct {
	dwLength                uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

// totalMem = os.totalmem()：libuv 在 Windows 上取 GlobalMemoryStatusEx 的 ullTotalPhys
func totalMem() uint64 {
	m := memoryStatusEx{dwLength: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		return 0
	}
	return m.ullTotalPhys
}
