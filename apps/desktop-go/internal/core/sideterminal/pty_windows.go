//go:build windows

package sideterminal

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modKernel32             = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePseudoConsole = modKernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole = modKernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole  = modKernel32.NewProc("ClosePseudoConsole")
)

const errorBrokenPipe windows.Errno = 109

type windowsPTY struct {
	mu      sync.Mutex
	hpc     windows.Handle
	inWrite windows.Handle
	outRead windows.Handle
	proc    windows.Handle
	job     windows.Handle
	shell   string
	closed  bool
	once    sync.Once
}

func packCoord(cols, rows uint16) uintptr {
	return uintptr(uint32(cols) | (uint32(rows) << 16))
}

func startPTY(opts StartOptions) (PTY, error) {
	for _, proc := range []*windows.LazyProc{procCreatePseudoConsole, procResizePseudoConsole, procClosePseudoConsole} {
		if err := proc.Find(); err != nil {
			return nil, ErrUnsupported
		}
	}

	var inRead, inWrite windows.Handle
	var outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		return nil, err
	}

	cols, rows := clampSize(int(opts.Cols), int(opts.Rows))
	var hpc windows.Handle
	r1, _, callErr := procCreatePseudoConsole.Call(
		packCoord(cols, rows),
		uintptr(inRead),
		uintptr(outWrite),
		0,
		uintptr(unsafe.Pointer(&hpc)),
	)
	if int32(r1) != 0 {
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		_ = windows.CloseHandle(outRead)
		_ = windows.CloseHandle(outWrite)
		if callErr != nil && callErr != windows.ERROR_SUCCESS {
			return nil, fmt.Errorf("CreatePseudoConsole: %w", callErr)
		}
		return nil, fmt.Errorf("CreatePseudoConsole hresult=0x%x", uint32(r1))
	}

	attrList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		_, _, _ = procClosePseudoConsole.Call(uintptr(hpc))
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		_ = windows.CloseHandle(outRead)
		_ = windows.CloseHandle(outWrite)
		return nil, err
	}
	// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 需要直接传 HPCON 句柄值本身，而非指针的指针。
	// 通过 unsafe.Add(nil, int(hpc)) 构造与 uintptr 等值的 unsafe.Pointer 以满足 go vet 静态检查。
	hpcPtr := unsafe.Add(nil, hpc)
	if err := attrList.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpcPtr, unsafe.Sizeof(hpc)); err != nil {
		attrList.Delete()
		_, _, _ = procClosePseudoConsole.Call(uintptr(hpc))
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		_ = windows.CloseHandle(outRead)
		_ = windows.CloseHandle(outWrite)
		return nil, err
	}

	cmdLine, shellName := resolveWindowsShell()
	cmdLinePtr, err := windows.UTF16PtrFromString(cmdLine)
	if err != nil {
		attrList.Delete()
		_, _, _ = procClosePseudoConsole.Call(uintptr(hpc))
		_ = windows.CloseHandle(inRead)
		_ = windows.CloseHandle(inWrite)
		_ = windows.CloseHandle(outRead)
		_ = windows.CloseHandle(outWrite)
		return nil, err
	}

	var dirPtr *uint16
	if opts.Dir != "" {
		dirPtr, err = windows.UTF16PtrFromString(opts.Dir)
		if err != nil {
			attrList.Delete()
			_, _, _ = procClosePseudoConsole.Call(uintptr(hpc))
			_ = windows.CloseHandle(inRead)
			_ = windows.CloseHandle(inWrite)
			_ = windows.CloseHandle(outRead)
			_ = windows.CloseHandle(outWrite)
			return nil, err
		}
	}

	envBlock := buildUTF16EnvBlock(buildEnv(opts.Env, false))
	var si windows.StartupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	si.ProcThreadAttributeList = attrList.List()
	// 与 microsoft/terminal 的 ConPTY 功能测试（src/winconpty/ft_pty/ConPtyTests.cpp，
	// AttachPseudoConsole）保持一致：STARTF_USESTDHANDLES 且三个标准句柄留空。
	// 父进程（go test / CI）本身已有控制台时，若子进程继承父进程的标准句柄，
	// 它会把普通 stdout/stderr 直接写到父控制台而绕过 ConPTY——管道上只剩 ConPTY
	// 自己生成的 VT（清屏、标题），真实输出（如 PS 提示符）落在父控制台上。
	// 留空后子进程的标准句柄由伪控制台提供。MSDN 要求 STARTF_USESTDHANDLES 时
	// bInheritHandles 必须为 TRUE；我们的管道句柄以 nil 安全属性创建、不可继承，
	// ConPTY 也已复制好 PTY 端，所以这里不会有额外的句柄被泄露给子进程。
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput = 0
	si.StdOutput = 0
	si.StdErr = 0

	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	err = windows.CreateProcess(
		nil,
		cmdLinePtr,
		nil,
		nil,
		true,
		flags,
		&envBlock[0],
		dirPtr,
		&si.StartupInfo,
		&pi,
	)

	// ConPTY 已将管道句柄传递给子进程；attrList 与子进程侧管道端可以立刻释放。
	attrList.Delete()
	_ = windows.CloseHandle(inRead)
	_ = windows.CloseHandle(outWrite)

	if err != nil {
		_, _, _ = procClosePseudoConsole.Call(uintptr(hpc))
		_ = windows.CloseHandle(inWrite)
		_ = windows.CloseHandle(outRead)
		return nil, err
	}
	_ = windows.CloseHandle(pi.Thread)

	job, jobErr := windows.CreateJobObject(nil, nil)
	if jobErr == nil && job != 0 {
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		_, _ = windows.SetInformationJobObject(
			job,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info)),
		)
		if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
			_ = windows.CloseHandle(job)
			job = 0
		}
	}

	return &windowsPTY{
		hpc:     hpc,
		inWrite: inWrite,
		outRead: outRead,
		proc:    pi.Process,
		job:     job,
		shell:   shellName,
	}, nil
}

func resolveWindowsShell() (cmdLine string, name string) {
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		return quoteWinCmd(p) + " -NoLogo", "pwsh"
	}
	if p, err := exec.LookPath("powershell.exe"); err == nil {
		return quoteWinCmd(p) + " -NoLogo", "powershell"
	}
	if comspec := strings.TrimSpace(os.Getenv("COMSPEC")); comspec != "" {
		return quoteWinCmd(comspec), strings.TrimSuffix(strings.ToLower(filepath.Base(comspec)), ".exe")
	}
	return "cmd.exe", "cmd"
}

func quoteWinCmd(p string) string {
	if strings.ContainsAny(p, " \t") {
		return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
	}
	return p
}

func buildUTF16EnvBlock(env []string) []uint16 {
	var block []uint16
	for _, entry := range env {
		if entry == "" {
			continue
		}
		block = append(block, utf16.Encode([]rune(entry))...)
		block = append(block, 0)
	}
	if len(block) == 0 {
		return []uint16{0, 0}
	}
	return append(block, 0)
}

func (w *windowsPTY) Shell() string {
	return w.shell
}

func (w *windowsPTY) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	var n uint32
	err := windows.ReadFile(w.outRead, p, &n, nil)
	if n > 0 {
		return int(n), err
	}
	if err == windows.ERROR_HANDLE_EOF || err == errorBrokenPipe {
		return 0, io.EOF
	}
	return 0, err
}

func (w *windowsPTY) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, os.ErrClosed
	}
	var total int
	for total < len(p) {
		var n uint32
		err := windows.WriteFile(w.inWrite, p[total:], &n, nil)
		total += int(n)
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}

func (w *windowsPTY) Resize(cols, rows uint16) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return os.ErrClosed
	}
	c, r := clampSize(int(cols), int(rows))
	r1, _, callErr := procResizePseudoConsole.Call(uintptr(w.hpc), packCoord(c, r))
	if int32(r1) != 0 {
		if callErr != nil && callErr != windows.ERROR_SUCCESS {
			return callErr
		}
		return fmt.Errorf("ResizePseudoConsole hresult=0x%x", uint32(r1))
	}
	return nil
}

func (w *windowsPTY) Wait() (int, string, error) {
	event, err := windows.WaitForSingleObject(w.proc, windows.INFINITE)
	if err != nil {
		return -1, "", err
	}
	if event != windows.WAIT_OBJECT_0 {
		return -1, "", fmt.Errorf("WaitForSingleObject returned %d", event)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(w.proc, &code); err != nil {
		return -1, "", err
	}
	return int(int32(code)), "", nil
}

func (w *windowsPTY) Close() error {
	w.once.Do(func() {
		w.mu.Lock()
		w.closed = true
		hpc := w.hpc
		w.hpc = 0
		inWrite := w.inWrite
		w.inWrite = 0
		w.mu.Unlock()

		if hpc != 0 {
			_, _, _ = procClosePseudoConsole.Call(uintptr(hpc))
		}
		if inWrite != 0 {
			_ = windows.CloseHandle(inWrite)
		}
		if w.job != 0 {
			_ = windows.CloseHandle(w.job)
			w.job = 0
		} else if w.proc != 0 {
			_ = windows.TerminateProcess(w.proc, 1)
		}
		if w.outRead != 0 {
			_ = windows.CloseHandle(w.outRead)
			w.outRead = 0
		}
		if w.proc != 0 {
			_ = windows.CloseHandle(w.proc)
			w.proc = 0
		}
	})
	return nil
}
