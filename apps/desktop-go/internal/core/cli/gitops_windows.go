package cli

import (
	"os"
	"os/exec"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// 与 libuv fs__realpath_handle 相同：CreateFileW(0, 0, OPEN_EXISTING, BACKUP_SEMANTICS)
// → GetFinalPathNameByHandleW(VOLUME_NAME_DOS)，去掉 `\\?\`，`\\?\UNC\` 改回 `\\`。
func realpathNative(p string) (string, error) {
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(u, 0, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0 /* VOLUME_NAME_DOS */)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]uint16, n+1)
	}
	s := windows.UTF16ToString(buf)
	switch {
	case strings.HasPrefix(s, `\\?\UNC\`):
		s = `\\` + s[8:]
	case strings.HasPrefix(s, `\\?\`):
		s = s[4:]
	}
	return s, nil
}

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func killTerm(p *os.Process) { _ = p.Kill() }

func isJunctionInfo(st os.FileInfo) bool { return st.Mode()&os.ModeIrregular != 0 }
