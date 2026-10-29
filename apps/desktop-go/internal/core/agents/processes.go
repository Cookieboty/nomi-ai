package agents

// processes.go 1:1 移植 agents/processes.ts：跨平台列出本机编程助手进程（只读）。

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// AgentProc mirrors AgentProc（Cwd "" = undefined）。
type AgentProc struct {
	Pid  float64
	Kind AgentKind
	Cwd  string
}

// RawProc mirrors RawProc。
type RawProc struct {
	Pid       float64
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
	reCodexDesk  = ri(`Codex\.app`)
	reCodexN     = ri(`^codex(\.exe)?$`)
	reCodexPkg   = ri(`@openai[\\/]codex`)
	reCodexTok   = tok(`codex(-[a-z0-9_-]+)?(\.exe)?`)
	reGeminiN    = ri(`^gemini(\.exe)?$`)
	reGeminiPkg  = ri(`@google[\\/]gemini-cli`)
	reGeminiTok  = tok(`gemini(\.exe)?`)
	reDshN       = ri(`^dsh(\.exe)?$`)
	reDshPkg     = ri(`@deepseek-ai[\\/]dsh[\\/]`)
	reDshTok     = tok(`dsh(\.exe)?`)
	reGrokN      = ri(`^grok(\.exe)?$`)
	reGrokPkg    = ri(`@xai-official[\\/]grok`)
	reGrokTok    = tok(`grok(\.exe)?`)
	reSelfTools  = ri(`^(ps|grep|rg|lsof|tasklist)(\.exe)?$`)
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

// Classify mirrors classify(procs, selfPid)。
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
		for _, r := range rules {
			if r.test(n, c) {
				out = append(out, AgentProc{Pid: p.Pid, Kind: r.kind})
				break
			}
		}
	}
	return out
}

// JS `.` 不匹配行终止符；\S = 非 JS 空白。
var rePsLine = regexp.MustCompile(`^` + ws + `*(\d+)` + ws + `+([^` + ws[1:len(ws)-1] + `]+)` + ws + `*([^\n\r\x{2028}\x{2029}]*)$`)

// ParsePs mirrors parsePs。
func ParsePs(stdout string) []RawProc {
	out := []RawProc{}
	for _, line := range strings.Split(stdout, "\n") {
		m := rePsLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		parts := strings.Split(m[2], "/")
		name := parts[len(parts)-1]
		pid, _ := strconv.ParseFloat(m[1], 64)
		cmd := m[3]
		if cmd == "" {
			cmd = m[2]
		}
		out = append(out, RawProc{Pid: pid, Name: name, Cmd: cmd})
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

// ParseWinJson mirrors parseWinJson。
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
		out = append(out, RawProc{Pid: pid, Name: reExe.ReplaceAllString(strOr(o.Get("Name")), ""), Cmd: strOr(cmdV)})
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

// ListAgentProcesses mirrors listAgentProcesses（nil = 整体失败/无法判断）。
func ListAgentProcesses(platform string) []AgentProc {
	self := float64(os.Getpid())
	if platform == "win32" {
		so, err := runCmd(8*time.Second, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress")
		if err != nil {
			return nil
		}
		return Classify(ParseWinJson(so), self)
	}
	so, err := runCmd(4*time.Second, "ps", "-A", "-o", "pid=,comm=,args=")
	if err != nil {
		return nil
	}
	found := Classify(ParsePs(so), self)
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

// ReadLockedInodes mirrors readLockedInodes(Async)（nil = 无法判断）。
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

// ParseProcLocks mirrors parseProcLocks。
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
