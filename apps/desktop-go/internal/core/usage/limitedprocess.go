package usage

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

type ProcessFailureKind string

// ProcessFailure mirrors class ProcessFailure（message = kind）。
type ProcessFailure struct{ Kind ProcessFailureKind }

func (e *ProcessFailure) Error() string { return string(e.Kind) }

type RunResult struct {
	Stdout string
	Code   *int
}

type RunOptions struct {
	Cwd       string
	Env       *util.Obj
	TimeoutMs int
	MaxBytes  int
	Platform  string // "" = process.platform
}

const StdoutLimit = 256 * 1024

// Killable = ChildProcess 子集（kill / exitCode / signalCode）。
type Killable interface {
	Kill(signal string) bool
	ExitCode() *int
	SignalCode() string
}

// KillTree：先 SIGTERM，宽限后 SIGKILL。
func KillTree(child Killable, graceMs int) {
	func() { defer func() { _ = recover() }(); child.Kill("SIGTERM") }()
	jsrt.SetTimeout(time.Duration(graceMs)*time.Millisecond, func() {
		defer func() { _ = recover() }()
		if child.ExitCode() == nil && child.SignalCode() == "" {
			child.Kill("SIGKILL")
		}
	})
}

var shimBad = regexp.MustCompile("[\"%\r\n]")

// WindowsShimLaunch = windowsShimLaunch。
func WindowsShimLaunch(command string, args []string, env *util.Obj) (file string, argv []string, ok bool) {
	all := append([]string{command}, args...)
	for _, v := range all {
		if shimBad.MatchString(v) {
			return "", nil, false
		}
	}
	q := make([]string, len(all))
	for i, v := range all {
		q[i] = `"` + v + `"`
	}
	quoted := strings.Join(q, " ")
	file = "cmd.exe"
	if s, ok := env.Get("ComSpec").(string); ok {
		file = s
	} else if env.Has("ComSpec") && env.Get("ComSpec") != nil {
		file = util.JSString(env.Get("ComSpec"))
	}
	return file, []string{"/d", "/s", "/c", `"` + quoted + `"`}, true
}

type CliLaunchVia string

const (
	ViaDirect     CliLaunchVia = "direct"
	ViaNodeScript CliLaunchVia = "node-script"
	ViaCmdShim    CliLaunchVia = "cmd-shim"
)

type CliLaunch struct {
	File string
	Args []string
	Via  CliLaunchVia
}

type UnwrapCmdDeps struct {
	ReadFile func(p string) (string, error)
	Exists   func(p string) bool
}

var (
	cmdBatRe   = regexp.MustCompile(`(?i)\.(cmd|bat)$`)
	dp0aRe     = regexp.MustCompile(`(?i)%~dp0%?`)
	dp0bRe     = regexp.MustCompile(`(?i)%dp0%?`)
	slashRe    = regexp.MustCompile(`[\\/]`)
	quotedRe   = regexp.MustCompile("\"([^\"\r\n]+)\"")
	jsExtRe    = regexp.MustCompile(`(?i)\.(?:m?js|cjs)$`)
	nodeNameRe = regexp.MustCompile(`(?i)(?:^|[\\/])node(?:\.exe)?$`)
)

// ExistsSync = fs.existsSync。
func ExistsSync(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// Normalize = path.normalize（宿主平台）：Clean 之外保留末尾分隔符，空串为 "."。
func Normalize(p string) string {
	if p == "" {
		return "."
	}
	c := filepath.Clean(p)
	sep := string(filepath.Separator)
	last := p[len(p)-1]
	if (last == '/' || (filepath.Separator == '\\' && last == '\\')) && !strings.HasSuffix(c, sep) {
		c += sep
	}
	return c
}

// UnwrapWindowsCmdShim = unwrapWindowsCmdShim。
func UnwrapWindowsCmdShim(command string, d UnwrapCmdDeps) (node, script string, ok bool) {
	if !cmdBatRe.MatchString(command) {
		return "", "", false
	}
	readFile := d.ReadFile
	if readFile == nil {
		readFile = func(p string) (string, error) {
			b, err := os.ReadFile(p)
			return string(b), err
		}
	}
	exists := d.Exists
	if exists == nil {
		exists = ExistsSync
	}
	text, err := readFile(command)
	if err != nil {
		return "", "", false
	}
	dir := filepath.Dir(command)
	dp0 := dir
	if !(strings.HasSuffix(dir, `\`) || strings.HasSuffix(dir, "/")) {
		dp0 = dir + string(filepath.Separator)
	}
	lit := func(s string) string { return strings.ReplaceAll(s, "$", "$$") }
	expand := func(raw string) string {
		s := dp0aRe.ReplaceAllString(raw, lit(dp0))
		s = dp0bRe.ReplaceAllString(s, lit(dp0))
		s = slashRe.ReplaceAllString(s, lit(string(filepath.Separator)))
		return Normalize(s)
	}
	var quoted []string
	for _, m := range quotedRe.FindAllStringSubmatch(text, -1) {
		if m[1] != "" {
			quoted = append(quoted, m[1])
		}
	}
	scriptRaw := ""
	for i := len(quoted) - 1; i >= 0; i-- {
		if jsExtRe.MatchString(quoted[i]) {
			scriptRaw = quoted[i]
			break
		}
	}
	if scriptRaw == "" {
		return "", "", false
	}
	script = expand(scriptRaw)
	if shimBad.MatchString(script) || !exists(script) {
		return "", "", false
	}
	localNode := filepath.Join(dir, "node.exe")
	nodeFromShim := ""
	for _, q := range quoted {
		e := expand(q)
		if nodeNameRe.MatchString(e) && exists(e) {
			nodeFromShim = e
			break
		}
	}
	switch {
	case exists(localNode):
		node = localNode
	case nodeFromShim != "":
		node = nodeFromShim
	default:
		node = "node.exe"
	}
	if shimBad.MatchString(node) {
		return "", "", false
	}
	return node, script, true
}

// ResolveCliLaunch = resolveCliLaunch（nil = null）。
func ResolveCliLaunch(command string, args []string, env *util.Obj, platform string, d UnwrapCmdDeps) *CliLaunch {
	if platform == "" {
		platform = Platform()
	}
	if platform != "win32" || !cmdBatRe.MatchString(command) {
		return &CliLaunch{File: command, Args: args, Via: ViaDirect}
	}
	if node, script, ok := UnwrapWindowsCmdShim(command, d); ok {
		return &CliLaunch{File: node, Args: append([]string{script}, args...), Via: ViaNodeScript}
	}
	file, argv, ok := WindowsShimLaunch(command, args, env)
	if !ok {
		return nil
	}
	return &CliLaunch{File: file, Args: argv, Via: ViaCmdShim}
}

// RunLimited = runLimited。
func RunLimited(command string, args []string, o RunOptions) *jsrt.Promise[RunResult] {
	p := jsrt.NewPromise[RunResult]()
	platform := o.Platform
	if platform == "" {
		platform = Platform()
	}
	launch := ResolveCliLaunch(command, args, o.Env, platform, UnwrapCmdDeps{})
	if launch == nil {
		p.Reject(&ProcessFailure{"failed"})
		return p
	}
	child := nodeproc.Spawn(launch.File, launch.Args, nodeproc.Options{
		Cwd: o.Cwd, Env: EnvSlice(o.Env), Verbatim: launch.Via == ViaCmdShim,
		IgnoreStdin: true, IgnoreStderr: true,
	})
	var mu sync.Mutex
	settled := false
	bytes := 0
	var chunks strings.Builder
	var timer *jsrt.Timer
	finish := func(err *ProcessFailure, code *int) {
		mu.Lock()
		if settled {
			mu.Unlock()
			return
		}
		settled = true
		mu.Unlock()
		jsrt.ClearTimeout(timer)
		if err != nil {
			KillTree(child, 800)
			p.Reject(err)
		} else {
			p.Resolve(RunResult{Stdout: chunks.String(), Code: code})
		}
	}
	timer = jsrt.SetTimeout(time.Duration(o.TimeoutMs)*time.Millisecond, func() { finish(&ProcessFailure{"timeout"}, nil) })
	child.OnError(func(e error) {
		k := ProcessFailureKind("failed")
		if se, ok := e.(*nodeproc.SpawnError); ok && se.Code == "ENOENT" {
			k = "not-installed"
		}
		finish(&ProcessFailure{k}, nil)
	})
	child.OnClose(func(code *int, _ string) { finish(nil, code) })
	child.OnStdoutBytes(func(c []byte) {
		bytes += len(c)
		if bytes > o.MaxBytes {
			finish(&ProcessFailure{"output-limit"}, nil)
		} else {
			chunks.Write(c)
		}
	})
	return p
}
