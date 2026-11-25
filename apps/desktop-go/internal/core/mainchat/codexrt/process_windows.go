//go:build windows

package codexrt

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

const stillActiveExitCode = 259

func killGroup(pid int) {
	if pid <= 0 {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	_ = windows.TerminateProcess(h, 1)
}

func groupGone(pid int) bool {
	if pid <= 0 {
		return true
	}
	if h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid)); err == nil {
		var code uint32
		err = windows.GetExitCodeProcess(h, &code)
		_ = windows.CloseHandle(h)
		if err == nil && code == stillActiveExitCode {
			return false
		}
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if pe.ProcessID == uint32(pid) || pe.ParentProcessID == uint32(pid) {
			return false
		}
	}
	return true
}

func directoryIdentity(path string, _ os.FileInfo) string {
	u, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "unavailable"
	}
	h, err := windows.CreateFile(u, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "unavailable"
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return "unavailable"
	}
	return fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
}
