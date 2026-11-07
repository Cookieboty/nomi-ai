package harness

import "golang.org/x/sys/windows"

var (
	ntdll              = windows.NewLazySystemDLL("ntdll.dll")
	procNtSuspendProc  = ntdll.NewProc("NtSuspendProcess")
	procNtResumeProc   = ntdll.NewProc("NtResumeProcess")
	processSuspendResu = uint32(0x0800) // PROCESS_SUSPEND_RESUME
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
