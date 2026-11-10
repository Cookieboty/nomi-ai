//go:build windows

package agents

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procK32GetProcessMemoryInfo = windows.NewLazySystemDLL("kernel32.dll").NewProc("K32GetProcessMemoryInfo")

// processMemoryCounters = PROCESS_MEMORY_COUNTERS
type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

// readProcessesNative：用 Toolhelp 快照 + 逐个进程查时间 / 内存 / 命令行（不起 PowerShell）；nil = 读不到，
// 调用方退回 PowerShell。字段与 Win32_Process 的 ProcessId / ParentProcessId / WorkingSetSize /
// KernelModeTime + UserModeTime / Name（去掉 .exe）/ CommandLine 对应；打不开的进程（系统进程等）只有前两项和名字。
func readProcessesNative() []RawProc {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return nil
	}
	out := []RawProc{}
	buf := make([]byte, 8192)
	for {
		exe := windows.UTF16ToString(e.ExeFile[:])
		p := RawProc{
			Pid:  float64(e.ProcessID),
			Ppid: float64(e.ParentProcessID),
			Name: reExe.ReplaceAllString(exe, ""),
			Cmd:  exe,
		}
		if h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID); err == nil {
			var created, exited, kernel, user windows.Filetime
			if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) == nil {
				p.CPU = (filetime100ns(kernel) + filetime100ns(user)) / 1e7
			}
			var mc processMemoryCounters
			mc.CB = uint32(unsafe.Sizeof(mc))
			if r, _, _ := procK32GetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&mc)), uintptr(mc.CB)); r != 0 {
				p.RSS = float64(mc.WorkingSetSize)
			}
			var cmd string
			cmd, buf = processCommandLine(h, buf)
			if strings.TrimSpace(cmd) != "" {
				p.Cmd = cmd
			}
			windows.CloseHandle(h)
		}
		out = append(out, p)
		if err := windows.Process32Next(snap, &e); err != nil {
			break
		}
	}
	return out
}

func filetime100ns(f windows.Filetime) float64 {
	return float64(uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime))
}

// processCommandLine：NtQueryInformationProcess(ProcessCommandLineInformation)，Windows 8.1 起可用；
// 读不到返回 ""。buf 不够时放大一次，返回（可能放大过的）buf 供下个进程复用。
func processCommandLine(h windows.Handle, buf []byte) (string, []byte) {
	for range 2 {
		var size uint32
		err := windows.NtQueryInformationProcess(h, windows.ProcessCommandLineInformation,
			unsafe.Pointer(&buf[0]), uint32(len(buf)), &size)
		if err == nil {
			return (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0])).String(), buf
		}
		if size <= uint32(len(buf)) || size > 1<<20 {
			return "", buf
		}
		buf = make([]byte, size)
	}
	return "", buf
}
