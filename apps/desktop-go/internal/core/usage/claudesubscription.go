package usage

// claudesubscription.go = packages/core/src/usage/claudeSubscription.ts
//
// Claude Code 额度兜底：用户点「刷新」且状态栏快照缺失 / 过期时，运行官方
// `claude -p /usage --output-format json`，由 Claude Code 自己用自己的登录态去取，Nomi 不接触任何凭据。
// 受限子进程：临时目录当 cwd；关遥测 / 错误上报 / 自动更新；超时 15 秒；stdout 上限 256KB；stderr 丢弃；
// Windows .cmd 垫片逐参引号；GUI PATH 补全（DefaultCliEnv = withCliPath）。

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
)

var ClaudeUsageArgs = []string{
	"-p", "/usage", "--output-format", "json", "--tools", "", "--strict-mcp-config",
	"--setting-sources", "", "--no-session-persistence",
}

const ClaudeUsageTimeoutMs = 15_000

// ClaudeUsageParse = ReturnType<typeof parseClaudeUsageResult>。
type ClaudeUsageParse struct {
	Windows     []QuotaWindow
	Denied      bool
	IsError     bool
	Unsupported bool
}

// ParseClaudeUsageResultFn = claudeUsageParser.parseClaudeUsageResult。claudeUsageParser 由 UsageService 侧
// 移植（同包另一文件）并在 init 里接上；未接上时等同解析抛错（= spawn-failed），见 §3.4。
var ParseClaudeUsageResultFn func(stdout string, now float64) ClaudeUsageParse

// DefaultClaudeBin / DefaultCodexBin：由 core/cli 在 init 时接上（= resolveCliBinAsync('claude'/'codex')）。
var (
	DefaultClaudeBin func() (string, bool)
	DefaultCodexBin  func() (string, bool)
)

// ClaudeUsageEnv = claudeUsageEnv(base)：base 为 nil = withCliPath()。
func ClaudeUsageEnv(base *util.Obj) *util.Obj {
	if base == nil {
		if DefaultCliEnv != nil {
			base = DefaultCliEnv()
		} else {
			base = ProcessEnv()
		}
	}
	o := base.Clone()
	o.Set("DISABLE_TELEMETRY", "1")
	o.Set("DISABLE_ERROR_REPORTING", "1")
	o.Set("DISABLE_AUTOUPDATER", "1")
	o.Set("NO_COLOR", "1")
	return o
}

// ClaudeFetcherDeps = ClaudeFetcherDeps（零值字段 = 默认）。
type ClaudeFetcherDeps struct {
	ResolveBin func() (string, bool)
	Run        func(cmd string, args []string, o RunOptions) *jsrt.Promise[RunResult]
	Env        func() *util.Obj
	TmpRoot    string
	Now        func() float64
	TimeoutMs  int
	Platform   string
}

// ClaudeUsageFetcher = class ClaudeUsageFetcher。
type ClaudeUsageFetcher struct {
	d           ClaudeFetcherDeps
	unsupported bool
}

func NewClaudeUsageFetcher(d ClaudeFetcherDeps) *ClaudeUsageFetcher { return &ClaudeUsageFetcher{d: d} }

func (f *ClaudeUsageFetcher) IsUnsupported() bool { return f.unsupported }

// resolveBinSafe = (resolveBin ?? default)().catch(() => null)。
func resolveBinSafe(fn, def func() (string, bool)) string {
	if fn == nil {
		fn = def
	}
	if fn == nil {
		return ""
	}
	bin, ok := "", false
	func() { defer func() { _ = recover() }(); bin, ok = fn() }()
	if !ok {
		return ""
	}
	return bin
}

// Fetch = async fetch(plan?)（plan "" = undefined）。须在 jsrt 线程内调用。
func (f *ClaudeUsageFetcher) Fetch(plan string) *jsrt.Promise[FetchOutcome] {
	return jsrt.Async(func() (FetchOutcome, error) { return f.fetch(plan), nil })
}

func (f *ClaudeUsageFetcher) fetch(plan string) (out FetchOutcome) {
	if f.unsupported {
		return FetchOutcome{Kind: "transient", Reason: "unsupported"}
	}
	bin := resolveBinSafe(f.d.ResolveBin, DefaultClaudeBin)
	if bin == "" {
		return FetchOutcome{Kind: "transient", Reason: "not-installed"}
	}
	root := f.d.TmpRoot
	if root == "" {
		root = os.TempDir()
	}
	dir, err := NodeMkdtemp(filepath.Join(root, "nomi-claude-usage-"))
	if err != nil {
		panic(jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "mkdtemp", filepath.Join(root, "nomi-claude-usage-XXXXXX"))})
	}
	var now float64
	if f.d.Now != nil {
		now = f.d.Now()
	} else {
		now = nowMs()
	}
	defer func() { _ = nodefs.RmForce(dir) }()
	defer func() {
		if r := recover(); r != nil {
			out = FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
		}
	}()
	run := f.d.Run
	if run == nil {
		run = RunLimited
	}
	envFn := f.d.Env
	if envFn == nil {
		envFn = func() *util.Obj { return ClaudeUsageEnv(nil) }
	}
	to := f.d.TimeoutMs
	if to == 0 {
		to = ClaudeUsageTimeoutMs
	}
	r, err := jsrt.Await(run(bin, ClaudeUsageArgs, RunOptions{Cwd: dir, Env: envFn(), TimeoutMs: to, MaxBytes: StdoutLimit, Platform: f.d.Platform}))
	if err != nil {
		var pf *ProcessFailure
		if errors.As(err, &pf) {
			switch pf.Kind {
			case "timeout", "output-limit", "not-installed":
				return FetchOutcome{Kind: "transient", Reason: string(pf.Kind)}
			}
		}
		return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
	}
	if ParseClaudeUsageResultFn == nil {
		panic(jsrt.JSThrow{Name: "TypeError", Message: "parseClaudeUsageResult is not wired"})
	}
	p := ParseClaudeUsageResultFn(r.Stdout, now)
	if p.Unsupported {
		f.unsupported = true
		return FetchOutcome{Kind: "transient", Reason: "unsupported"}
	}
	if p.Denied {
		return FetchOutcome{Kind: "auth", Reason: "denied"}
	}
	if r.Code == nil || *r.Code != 0 || p.IsError {
		return FetchOutcome{Kind: "transient", Reason: "bad-output"}
	}
	if len(p.Windows) == 0 {
		return FetchOutcome{Kind: "transient", Reason: "no-limits"}
	}
	return FetchOutcome{Kind: "ok", Reading: &QuotaReading{Windows: p.Windows, UpdatedAt: now, Origin: "usage-cmd", Plan: plan}}
}
