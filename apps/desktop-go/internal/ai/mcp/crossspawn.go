package mcp

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// cross-spawn 7.0.6（parse.js / escape.js / resolveCommand.js / readShebang.js / enoent.js）在 Windows 上的行为：
// node child_process.spawn 不跑 .cmd/.bat，cross-spawn 先用 which 解析（PATHEXT），非 .com/.exe 则改经
// cmd.exe /d /s /c "<escaped>"（windowsVerbatimArguments）；exit code 1 且解析不到文件 = 'error' ENOENT。

type crossParsed struct {
	command  string
	args     []string
	file     string // resolveCommand 结果（"" = undefined）
	verbatim bool
	original string
}

var (
	isExecutableRe = regexp.MustCompile(`(?i)\.(?:com|exe)$`)
	isCmdShimRe    = regexp.MustCompile(`(?i)node_modules[\\/].bin[\\/][^\\/]+\.cmd$`)
	metaCharsRe    = regexp.MustCompile("([()\\][%!^\"`<>&|;, *?])")
)

type crossEnv struct {
	env     [][2]string // 子进程 env（options.env）
	cwd     string      // process.cwd()
	pathext string      // process.env.PATHEXT（"" = undefined）
	comspec string      // process.env.comspec（"" = undefined）
	stat    func(string) (os.FileInfo, error)
	read    func(string) ([]byte, error)
}

func crossSpawnParse(command string, args []string, e crossEnv) crossParsed {
	p := crossParsed{command: command, args: append([]string(nil), args...), original: command}
	commandFile := detectShebang(&p, e)
	needsShell := !isExecutableRe.MatchString(commandFile)
	if needsShell {
		double := isCmdShimRe.MatchString(commandFile)
		p.command = winNormalize(p.command)
		p.command = metaCharsRe.ReplaceAllString(p.command, "^$1")
		for i, a := range p.args {
			p.args[i] = escapeArgument(a, double)
		}
		shellCommand := strings.Join(append([]string{p.command}, p.args...), " ")
		p.args = []string{"/d", "/s", "/c", `"` + shellCommand + `"`}
		p.command = e.comspec
		if p.command == "" {
			p.command = "cmd.exe"
		}
		p.verbatim = true
	}
	return p
}

func escapeArgument(arg string, double bool) string {
	var b strings.Builder
	for i := 0; i < len(arg); i++ {
		if arg[i] == '"' {
			if i > 0 && arg[i-1] == '\\' {
				b.WriteString(`\\"`)
				continue
			}
			b.WriteString(`\"`)
			continue
		}
		b.WriteByte(arg[i])
	}
	s := b.String()
	if strings.HasSuffix(s, `\`) {
		s += `\`
	}
	s = `"` + s + `"`
	s = metaCharsRe.ReplaceAllString(s, "^$1")
	if double {
		s = metaCharsRe.ReplaceAllString(s, "^$1")
	}
	return s
}

func detectShebang(p *crossParsed, e crossEnv) string {
	p.file = resolveCommand(p.command, e)
	if p.file != "" {
		if sh := readShebang(p.file, e); sh != "" {
			p.args = append([]string{p.file}, p.args...)
			p.command = sh
			return resolveCommand(p.command, e)
		}
	}
	return p.file
}

func readShebang(file string, e crossEnv) string {
	b, err := e.read(file)
	if err != nil {
		b = nil
	}
	if len(b) > 150 {
		b = b[:150]
	}
	buf := make([]byte, 150) // Buffer.alloc(150)：不足部分为 \0
	copy(buf, b)
	s := string(buf)
	m := regexp.MustCompile(`^#!(.*)`).FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	parts := strings.Split(regexp.MustCompile(`#! ?`).ReplaceAllString(m[0], ""), " ")
	path := parts[0]
	bin := path[strings.LastIndex(path, "/")+1:]
	arg := ""
	if len(parts) > 1 {
		arg = parts[1]
	}
	if bin == "env" {
		return arg
	}
	if arg != "" {
		return bin + " " + arg
	}
	return bin
}

func resolveCommand(cmd string, e crossEnv) string {
	if r := resolveAttempt(cmd, e, false); r != "" {
		return r
	}
	return resolveAttempt(cmd, e, true)
}

// which.sync（which 2.0.2 + isexe Windows 分支）
func resolveAttempt(cmd string, e crossEnv, withoutPathExt bool) string {
	pathVal := ""
	for i := len(e.env) - 1; i >= 0; i-- { // path-key：反向找第一个 /^PATH$/i
		if strings.ToUpper(e.env[i][0]) == "PATH" {
			pathVal = e.env[i][1]
			break
		}
	}
	var pathEnv []string
	if strings.ContainsAny(cmd, `/\`) {
		pathEnv = []string{""}
	} else {
		pathEnv = append([]string{e.cwd}, strings.Split(pathVal, ";")...)
	}
	pathExtExe := e.pathext
	if withoutPathExt {
		pathExtExe = ";"
	} else if pathExtExe == "" {
		pathExtExe = ".EXE;.CMD;.BAT;.COM"
	}
	pathExt := strings.Split(pathExtExe, ";")
	if strings.Contains(cmd, ".") && pathExt[0] != "" {
		pathExt = append([]string{""}, pathExt...)
	}
	for _, raw := range pathEnv {
		part := raw
		if len(raw) >= 2 && strings.HasPrefix(raw, `"`) && strings.HasSuffix(raw, `"`) {
			part = raw[1 : len(raw)-1]
		}
		pCmd := winJoin(part, cmd)
		if part == "" && (strings.HasPrefix(cmd, `.\`) || strings.HasPrefix(cmd, "./")) {
			pCmd = cmd[:2] + pCmd
		}
		for _, ext := range pathExt {
			cur := pCmd + ext
			if isExe(cur, pathExtExe, e) {
				return winResolve(e.cwd, cur)
			}
		}
	}
	return ""
}

func isExe(p, pathext string, e crossEnv) bool {
	st, err := e.stat(p)
	if err != nil || !(st.Mode().IsRegular() || st.Mode()&os.ModeSymlink != 0) {
		return false
	}
	if pathext == "" {
		return true
	}
	exts := strings.Split(pathext, ";")
	for _, x := range exts {
		if x == "" {
			return true
		}
	}
	for _, x := range exts {
		x = strings.ToLower(x)
		if len(p) >= len(x) && strings.ToLower(p[len(p)-len(x):]) == x {
			return true
		}
	}
	return false
}

// path.win32.join / normalize / resolve 的近似（filepath 在 Windows 上等价）
func winJoin(a, b string) string {
	if a == "" {
		return winNormalize(b)
	}
	return winNormalize(a + `\` + b)
}

func winNormalize(p string) string {
	if p == "" {
		return "."
	}
	trailing := strings.HasSuffix(p, `\`) || strings.HasSuffix(p, "/")
	c := filepath.Clean(strings.ReplaceAll(p, "/", `\`))
	if trailing && !strings.HasSuffix(c, `\`) {
		c += `\`
	}
	return c
}

func winResolve(cwd, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(cwd, p)
}

// crossENOENT = enoent.verifyENOENT：exit code 1 且 parsed.file 为空
func crossENOENT(code *int, p crossParsed) error {
	if code != nil && *code == 1 && p.file == "" {
		return &crossNotFound{cmd: p.original}
	}
	return nil
}

type crossNotFound struct{ cmd string }

func (e *crossNotFound) Error() string { return "spawn " + e.cmd + " ENOENT" }
