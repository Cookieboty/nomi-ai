package computer

// macOS 的辅助功能 / 屏幕录制权限（TCC）算在「启动 agent-desktop 的应用」头上：从 Nomi 里调用时是 Nomi.app，
// 开发时（pnpm dev）是运行它的终端。只给 agent-desktop 本身授权没有用，设置页要告诉用户该允许哪个应用。

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// appOfPath：路径里的 .app 包名（/Applications/Ghostty.app/Contents/MacOS/ghostty → Ghostty）；不在 .app 里返回 ""
func appOfPath(p string) string {
	i := strings.Index(p, ".app/")
	if i < 0 {
		if strings.HasSuffix(p, ".app") {
			i = len(p) - len(".app")
		} else {
			return ""
		}
	}
	return filepath.Base(p[:i])
}

// parentOf：父进程 id 与可执行文件路径（ps；失败返回 0）
type parentFn func(pid int) (ppid int, comm string)

func psParent(pid int) (int, string) {
	out, err := exec.Command("ps", "-o", "ppid=,comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, ""
	}
	f := strings.Fields(strings.TrimSpace(string(out)))
	if len(f) < 2 {
		return 0, ""
	}
	ppid, _ := strconv.Atoi(f[0])
	return ppid, strings.Join(f[1:], " ")
}

// responsibleApp：沿父进程往上找第一个 .app（自己在 .app 里就是自己）
func responsibleApp(exe string, pid int, parent parentFn) string {
	if a := appOfPath(exe); a != "" {
		return a
	}
	for i := 0; i < 12 && pid > 1; i++ {
		ppid, comm := parent(pid)
		if a := appOfPath(comm); a != "" {
			return a
		}
		pid = ppid
	}
	return ""
}

// PermissionApp：macOS 上需要在「隐私与安全性」里授权的应用名（其它平台 / 找不到时 ""）
func (s *Service) PermissionApp() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	exe, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return responsibleApp(exe, os.Getpid(), psParent)
}
