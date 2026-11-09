package agents

// processes.go：跨平台列出本机编程助手进程（只读）。

import (
	"context"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// AgentProc：编程助手进程（Cwd "" = undefined）。Ppid / RSS 0 = 不知道；RSS 是这个进程自己的常驻内存（字节）。
type AgentProc struct {
	Pid  float64
	Kind AgentKind
	Cwd  string
	Ppid float64
	RSS  float64
}

// RawProc：进程列表里的一项。Ppid / RSS / CPU 0 = 不知道；RSS 单位字节；CPU 是累计 CPU 时间（秒，
// 用户态 + 内核态），两次采样相减才是当下的占用（见 ProcTable.CPUSince）。
type RawProc struct {
	Pid       float64
	Ppid      float64
	RSS       float64
	CPU       float64
	Name, Cmd string
}

const ws = util.JSWhitespace

// tok = /(^|[\\/\s])NAME(\s|$)/i
func tok(name string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)(?:^|[\\/]|` + ws + `)` + name + `(?:` + ws + `|$)`)
}
func ri(src string) *regexp.Regexp { return regexp.MustCompile(`(?i)` + src) }

var (
	reClaudeDesk = ri(`Claude\.app|Claude Helper|AnthropicClaude|claude-desktop`)
	reClaudeN    = ri(`^claude(\.exe)?$`)
	reClaudePkg  = ri(`@anthropic-ai[\\/]claude-code`)
	reClaudeTok  = tok(`claude(\.exe)?`)
	// ChatGPT 桌面版的辅助进程路径里有「Codex Framework.framework」，不是 codex CLI
	reCodexDesk = ri(`Codex\.app|Codex Framework\.framework`)
	reCodexN    = ri(`^codex(\.exe)?$`)
	reCodexPkg  = ri(`@openai[\\/]codex`)
	reCodexTok  = tok(`codex(-[a-z0-9_-]+)?(\.exe)?`)
	reGeminiN   = ri(`^gemini(\.exe)?$`)
	reGeminiPkg = ri(`@google[\\/]gemini-cli`)
	reGeminiTok = tok(`gemini(\.exe)?`)
	reDshN      = ri(`^dsh(\.exe)?$`)
	reDshPkg    = ri(`@deepseek-ai[\\/]dsh[\\/]`)
	reDshTok    = tok(`dsh(\.exe)?`)
	reGrokN     = ri(`^grok(\.exe)?$`)
	reGrokPkg   = ri(`@xai-official[\\/]grok`)
	reGrokTok   = tok(`grok(\.exe)?`)
	reSelfTools = ri(`^(ps|grep|rg|lsof|tasklist)(\.exe)?$`)
)

var rules = []struct {
	kind AgentKind
	test func(n, c string) bool
}{
	{"claude", func(n, c string) bool {
		return !reClaudeDesk.MatchString(c) && (reClaudeN.MatchString(n) || reClaudePkg.MatchString(c) || reClaudeTok.MatchString(c))
	}},
	{"codex", func(n, c string) bool {
		return !reCodexDesk.MatchString(c) && (reCodexN.MatchString(n) || reCodexPkg.MatchString(c) || reCodexTok.MatchString(c))
	}},
	{"gemini", func(n, c string) bool {
		return reGeminiN.MatchString(n) || reGeminiPkg.MatchString(c) || reGeminiTok.MatchString(c)
	}},
	{"dsh", func(n, c string) bool {
		return reDshN.MatchString(n) || reDshPkg.MatchString(c) || reDshTok.MatchString(c)
	}},
	{"grok", func(n, c string) bool {
		return reGrokN.MatchString(n) || reGrokPkg.MatchString(c) || reGrokTok.MatchString(c)
	}},
}

// genericRules：上面没有专门规则的内置编程助手：进程名是它的可执行文件名，或命令行里有它的 npm 包 / 可执行文件
var genericRules = func() []struct {
	kind AgentKind
	test func(n, c string) bool
} {
	known := map[AgentKind]bool{}
	for _, r := range rules {
		known[r.kind] = true
	}
	out := []struct {
		kind AgentKind
		test func(n, c string) bool
	}{}
	for _, id := range builtin.Ordered {
		if known[AgentKind(id)] {
			continue
		}
		var name, cmd []*regexp.Regexp
		for _, b := range builtin.Binaries(id) {
			q := regexp.QuoteMeta(b)
			name = append(name, ri(`^`+q+`(\.exe)?$`))
			cmd = append(cmd, tok(q+`(\.exe)?`))
		}
		if p := builtin.NpmPackage(id); p != "" {
			cmd = append(cmd, ri(strings.ReplaceAll(regexp.QuoteMeta(p), "/", `[\\/]`)))
		}
		out = append(out, struct {
			kind AgentKind
			test func(n, c string) bool
		}{AgentKind(id), func(n, c string) bool {
			for _, r := range name {
				if r.MatchString(n) {
					return true
				}
			}
			for _, r := range cmd {
				if r.MatchString(c) {
					return true
				}
			}
			return false
		}})
	}
	return out
}()

var allRules = append(rules[:len(rules):len(rules)], genericRules...)

// Classify：从进程列表里挑出编程助手（排除自身 selfPid）。
func Classify(procs []RawProc, selfPid float64) []AgentProc {
	out := []AgentProc{}
	for _, p := range procs {
		if p.Pid == selfPid {
			continue
		}
		n, c := util.JSIText(p.Name), util.JSIText(p.Cmd)
		if reSelfTools.MatchString(n) {
			continue
		}
		for _, r := range allRules {
			if r.test(n, c) {
				out = append(out, AgentProc{Pid: p.Pid, Kind: r.kind, Ppid: p.Ppid, RSS: p.RSS})
				break
			}
		}
	}
	return out
}

// psArgs：ps 的列；rss 单位 KB（macOS 与 Linux 一致）；time 是累计 CPU 时间（macOS「分:秒.百分秒」，
// Linux「[天-]时:分:秒」，只到秒）。不用 %cpu：macOS 是衰减平均、Linux 是整个生命周期的平均。
// macOS 的 comm 不在最后一列时截到 16 个字符，所以认编程助手主要靠 args。
var psArgs = []string{"-A", "-o", "pid=,ppid=,rss=,time=,comm=,args="}

// ParseCPUTime：ps 的 time 列 → 秒（认不出 = 0）。
func ParseCPUTime(s string) float64 {
	days := 0.0
	if i := strings.IndexByte(s, '-'); i >= 0 {
		d, err := strconv.ParseFloat(s[:i], 64)
		if err != nil {
			return 0
		}
		days, s = d, s[i+1:]
	}
	parts := strings.Split(s, ":")
	if len(parts) > 3 {
		return 0
	}
	sec := 0.0
	for _, p := range parts {
		v, err := strconv.ParseFloat(p, 64)
		if err != nil || v < 0 {
			return 0
		}
		sec = sec*60 + v
	}
	return days*86400 + sec
}

// JS `.` 不匹配行终止符；\S = 非 JS 空白。
var rePsLine = regexp.MustCompile(`^` + ws + `*(\d+)` + ws + `+(\d+)` + ws + `+(\d+)` + ws + `+([\d:.-]+)` + ws + `+([^` + ws[1:len(ws)-1] + `]+)` + ws + `*([^\n\r\x{2028}\x{2029}]*)$`)

// ParsePs：解析 ps 输出（psArgs 的列）。
func ParsePs(stdout string) []RawProc {
	out := []RawProc{}
	for _, line := range strings.Split(stdout, "\n") {
		m := rePsLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		parts := strings.Split(m[5], "/")
		name := parts[len(parts)-1]
		pid, _ := strconv.ParseFloat(m[1], 64)
		ppid, _ := strconv.ParseFloat(m[2], 64)
		rssKB, _ := strconv.ParseFloat(m[3], 64)
		cmd := m[6]
		if cmd == "" {
			cmd = m[5]
		}
		out = append(out, RawProc{Pid: pid, Ppid: ppid, RSS: rssKB * 1024, CPU: ParseCPUTime(m[4]), Name: name, Cmd: cmd})
	}
	return out
}

var reExe = regexp.MustCompile(`(?i)\.exe$`)

func strOr(v any) string {
	if v == nil {
		return ""
	}
	return util.JSString(v)
}

// ParseWinJson：解析 Windows 进程列表的 JSON 输出。
func ParseWinJson(stdout string) []RawProc {
	v, err := util.ParseString(stdout)
	if err != nil {
		return []RawProc{}
	}
	arr, ok := v.([]any)
	if !ok {
		arr = []any{v}
	}
	out := []RawProc{}
	for _, x := range arr {
		if !util.IsObj(x) {
			continue
		}
		o := x.(*util.Obj)
		pid, ok := o.Get("ProcessId").(float64)
		if !ok {
			continue
		}
		cmdV := o.Get("CommandLine")
		if cmdV == nil {
			cmdV = o.Get("Name")
		}
		ppid, _ := o.Get("ParentProcessId").(float64)
		rss, _ := o.Get("WorkingSetSize").(float64)
		// KernelModeTime / UserModeTime：100 纳秒为单位
		kt, _ := o.Get("KernelModeTime").(float64)
		ut, _ := o.Get("UserModeTime").(float64)
		out = append(out, RawProc{Pid: pid, Ppid: ppid, RSS: rss, CPU: (kt + ut) / 1e7, Name: reExe.ReplaceAllString(strOr(o.Get("Name")), ""), Cmd: strOr(cmdV)})
	}
	return out
}

func runCmd(timeout time.Duration, cmd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := exec.CommandContext(ctx, cmd, args...)
	hideWindow(c)
	b, err := c.Output()
	if err == nil && len(b) > 16*1024*1024 {
		return "", os.ErrInvalid
	}
	return string(b), err
}

func cwdsMac(pids []float64) map[float64]string {
	m := map[float64]string{}
	if len(pids) == 0 {
		return m
	}
	ps := make([]string, len(pids))
	for i, p := range pids {
		ps[i] = util.JSString(p)
	}
	so, err := runCmd(4*time.Second, "lsof", "-a", "-d", "cwd", "-p", strings.Join(ps, ","), "-Fpn")
	if err != nil {
		return m
	}
	pid := 0.0
	for _, l := range strings.Split(so, "\n") {
		if strings.HasPrefix(l, "p") {
			pid = jsNumber(l[1:])
		} else if strings.HasPrefix(l, "n") && pid != 0 && pid == pid {
			m[pid] = l[1:]
		}
	}
	return m
}

func jsNumber(s string) float64 {
	t := util.JSTrim(s)
	if t == "" {
		return 0
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return nanv
	}
	return f
}

var nanv = func() float64 { z := 0.0; return z / z }()

// ReadProcesses：本机全部进程（含父进程与常驻内存；nil = 读不到）。
func ReadProcesses(platform string) []RawProc {
	if platform == "win32" {
		so, err := runCmd(8*time.Second, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name,CommandLine | ConvertTo-Json -Compress")
		if err != nil {
			return nil
		}
		return ParseWinJson(so)
	}
	so, err := runCmd(4*time.Second, "ps", psArgs...)
	if err != nil {
		return nil
	}
	return ParsePs(so)
}

// ListAgentProcesses：列出编程助手进程（nil = 整体失败/无法判断）。
func ListAgentProcesses(platform string) []AgentProc {
	procs := ReadProcesses(platform)
	if procs == nil {
		return nil
	}
	found := Classify(procs, float64(os.Getpid()))
	if platform == "win32" {
		return found
	}
	switch platform {
	case "linux":
		for i := range found {
			if l, err := os.Readlink("/proc/" + util.JSString(found[i].Pid) + "/cwd"); err == nil {
				found[i].Cwd = l
			}
		}
	case "darwin":
		pids := make([]float64, len(found))
		for i, p := range found {
			pids[i] = p.Pid
		}
		cw := cwdsMac(pids)
		for i := range found {
			found[i].Cwd = cw[found[i].Pid]
		}
	}
	return found
}

// ReadLockedInodes：被进程锁住的文件 inode（nil = 无法判断）。
func ReadLockedInodes(platform string) map[float64]bool {
	if platform != "linux" {
		return nil
	}
	b, err := os.ReadFile("/proc/locks")
	if err != nil {
		return nil
	}
	return ParseProcLocks(string(b))
}

var (
	reLockIno  = regexp.MustCompile(`(?i)` + ws + `(?:[0-9a-f]+):(?:[0-9a-f]+):(\d+)` + ws)
	reLockKind = regexp.MustCompile(`FLOCK|POSIX|OFDLCK`)
)

// ParseProcLocks：解析 /proc/locks。
func ParseProcLocks(raw string) map[float64]bool {
	out := map[float64]bool{}
	for _, line := range strings.Split(raw, "\n") {
		m := reLockIno.FindStringSubmatch(util.JSIText(line))
		if m != nil && reLockKind.MatchString(line) {
			f, _ := strconv.ParseFloat(m[1], 64)
			out[f] = true
		}
	}
	return out
}
