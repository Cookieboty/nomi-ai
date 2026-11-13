package computer

import (
	"path/filepath"
	"strings"
)

// isBatchFile：Windows 的 npm 垫片（agent-desktop.cmd、npm.cmd）
func isBatchFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".cmd", ".bat":
		return true
	default:
		return false
	}
}

// quoteBatch：cmd.exe 参数。含空格或 cmd 元字符时加引号，内部引号加倍。
func quoteBatch(s string) string {
	if s == "" {
		return `""`
	}
	if !strings.ContainsAny(s, " \t\"&<>^|%") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func batchScript(bin string, args []string) string {
	parts := make([]string, 0, 1+len(args))
	parts = append(parts, quoteBatch(bin))
	for _, a := range args {
		parts = append(parts, quoteBatch(a))
	}
	return strings.Join(parts, " ")
}

func quoteExe(s string) string {
	if strings.ContainsAny(s, " \t") {
		return `"` + s + `"`
	}
	return s
}

// windowsBatchLaunch：用 cmd.exe /d /s /c 跑一个 .cmd / .bat。
// /s 剥掉 /c 后面最外层的一对引号，所以带空格的垫片路径仍是一条命令。
// 返回的 cmdline 交给 SysProcAttr.CmdLine，避免 Go 再按 CommandLineToArgvW 加一层引号。
func windowsBatchLaunch(comspec, bin string, args []string) (path string, argv []string, cmdline string) {
	script := batchScript(bin, args)
	path = comspec
	argv = []string{comspec, "/d", "/s", "/c", script}
	cmdline = quoteExe(comspec) + " /d /s /c \"" + script + "\""
	return path, argv, cmdline
}
