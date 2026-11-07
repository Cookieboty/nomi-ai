package harness

import (
	"strconv"

	"golang.org/x/sys/windows"
)

var (
	ntdll              = windows.NewLazySystemDLL("ntdll.dll")
	procNtSuspendProc  = ntdll.NewProc("NtSuspendProcess")
	procNtResumeProc   = ntdll.NewProc("NtResumeProcess")
	processSuspendResu = uint32(0x0800) // PROCESS_SUSPEND_RESUME
	processQueryLimInf = uint32(0x1000) // PROCESS_QUERY_LIMITED_INFORMATION
)

func ntCall(p *windows.LazyProc, pid int) error {
	h, err := windows.OpenProcess(processSuspendResu, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	if r, _, _ := p.Call(uintptr(h)); r != 0 {
		return windows.NTStatus(r)
	}
	return nil
}

// suspendPid / resumePid：冻结 / 恢复一个进程的全部线程（NtSuspendProcess / NtResumeProcess）
func suspendPid(pid int) error { return ntCall(procNtSuspendProc, pid) }
func resumePid(pid int) error  { return ntCall(procNtResumeProc, pid) }

// procStarts：进程的创建时间（GetProcessTimes），用来认「还是不是当初那个进程」；读不到的不在结果里
func procStarts(pids []int) map[int]string {
	out := map[int]string{}
	for _, pid := range pids {
		h, err := windows.OpenProcess(processQueryLimInf, false, uint32(pid))
		if err != nil {
			continue
		}
		var c, e, k, u windows.Filetime
		if windows.GetProcessTimes(h, &c, &e, &k, &u) == nil {
			out[pid] = strconv.FormatUint(uint64(c.HighDateTime)<<32|uint64(c.LowDateTime), 10)
		}
		windows.CloseHandle(h)
	}
	return out
}
