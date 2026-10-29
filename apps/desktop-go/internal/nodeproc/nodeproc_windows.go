//go:build windows

package nodeproc

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// lookPath = libuv win/process.c search_path：
// 名字带路径分隔符 → 只试这一个（相对 cwd）；否则先 cwd，再子进程 env 的 PATH（没有则父进程 PATH）；
// 名字自带扩展名先原样试，再试 .com、.exe（不会命中 .cmd/.bat）。
func lookPath(file, cwd string, env []string) (string, error) {
	if file == "" {
		return "", errENOENT
	}
	try := func(dir string) (string, bool) {
		base := file
		if dir != "" {
			base = filepath.Join(dir, file)
		}
		if !filepath.IsAbs(base) && cwd != "" {
			base = filepath.Join(cwd, base)
		}
		if ext := filepath.Ext(file); ext != "" && ext != "." {
			if isFile(base) {
				return base, true
			}
		}
		for _, e := range []string{".com", ".exe"} {
			if isFile(base + e) {
				return base + e, true
			}
		}
		return "", false
	}
	if strings.ContainsAny(file, `\/:`) {
		if p, ok := try(""); ok {
			return p, nil
		}
		return "", errENOENT
	}
	if p, ok := try(cwd); ok {
		return p, nil
	}
	pathEnv, ok := envGet(env, "PATH", true)
	if !ok {
		pathEnv = os.Getenv("PATH")
	}
	for _, dir := range splitWinPath(pathEnv) {
		if dir == "" {
			continue
		}
		if p, ok := try(dir); ok {
			return p, nil
		}
	}
	return "", errENOENT
}

// splitWinPath：分号分隔，支持 "..." 包住的段（libuv 同款）。
func splitWinPath(s string) []string {
	var out []string
	var cur strings.Builder
	q := false
	for _, r := range s {
		switch {
		case r == '"':
			q = !q
		case r == ';' && !q:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	return append(out, cur.String())
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// QuoteArg = libuv quote_cmd_arg。
func QuoteArg(s string) string {
	if s == "" {
		return `""`
	}
	if !strings.ContainsAny(s, " \t\"") {
		return s
	}
	if !strings.ContainsAny(s, "\"\\") {
		return `"` + s + `"`
	}
	// libuv：从尾部倒着写再反转
	r := []rune(s)
	var out []rune
	out = append(out, '"')
	quoteHit := true
	for i := len(r) - 1; i >= 0; i-- {
		out = append(out, r[i])
		if quoteHit && r[i] == '\\' {
			out = append(out, '\\')
		} else if r[i] == '"' {
			quoteHit = true
			out = append(out, '\\')
		} else {
			quoteHit = false
		}
	}
	out = append(out, '"')
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

const createNoWindow = 0x08000000
const detachedProcess = 0x00000008

func setSysProcAttr(cmd *exec.Cmd, file, path string, args []string, o Options) {
	parts := make([]string, 0, len(args)+1)
	if o.Verbatim {
		parts = append(parts, file)
		parts = append(parts, args...)
	} else {
		parts = append(parts, QuoteArg(file))
		for _, a := range args {
			parts = append(parts, QuoteArg(a))
		}
	}
	attr := &syscall.SysProcAttr{CmdLine: strings.Join(parts, " "), HideWindow: true, CreationFlags: createNoWindow}
	if o.Detached {
		attr.CreationFlags |= detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP
	}
	cmd.SysProcAttr = attr
}

func errnoOf(err error) int {
	// libuv Windows 错误码：ENOENT -4058、EACCES -4092
	if codeOf(err) == "EACCES" {
		return -4092
	}
	return -4058
}

func codeOf(err error) string {
	var en syscall.Errno
	if errors.As(err, &en) && (en == syscall.ERROR_ACCESS_DENIED) {
		return "EACCES"
	}
	return "ENOENT"
}

func killProcess(p *os.Process, signal string) error {
	switch signal {
	case "SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT":
		h, err := syscall.OpenProcess(syscall.PROCESS_TERMINATE, false, uint32(p.Pid))
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(h)
		return syscall.TerminateProcess(h, 1)
	}
	return errors.New("ENOSYS")
}

// KillPid = process.kill(pid, signal)。
func KillPid(pid int, signal string) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return killProcess(p, signal)
}

func exitStatus(cmd *exec.Cmd, werr error, termSignal string) (*int, string) {
	if termSignal != "" {
		return nil, termSignal
	}
	c := cmd.ProcessState.ExitCode()
	return &c, ""
}
