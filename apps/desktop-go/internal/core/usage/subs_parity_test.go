package usage

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 回放 scripts/parity/record-usage-subs.mjs：claudeSubscription / codexRateLimits / grokSubscription。
// 子进程场景跑同一个 usage-mock-cli，比对 FetchOutcome、mock 看到的 argv/cwd/env/stdin 每一行、临时目录残留。

type subsScenario struct {
	Name          string            `json:"name"`
	Bin           *string           `json:"bin"`
	Plan          json.RawMessage   `json:"plan"`
	FetchPlan     string            `json:"fetchPlan"`
	Twice         bool              `json:"twice"`
	TimeoutMs     int               `json:"timeoutMs"`
	ExtraArgs     []string          `json:"extraArgs"`
	ClientVersion string            `json:"clientVersion"`
	Outs          []string          `json:"outs"`
	Unsupported   bool              `json:"unsupported"`
	Log           []json.RawMessage `json:"log"`
	Left          []string          `json:"left"`
	PlanKind      string            `json:"planKind"`
}

// planKindOf = recorder 的 planKind()：reading 里 plan 的 JS 值类别。
func planKindOf(r *QuotaReading) string {
	if r == nil {
		return "none"
	}
	switch r.PlanKind {
	case PlanFunction:
		return "function"
	case PlanObjectProto:
		return "Object.prototype"
	}
	if r.Plan == "" {
		return "none"
	}
	return "string"
}

type subsGolden struct {
	Now    float64 `json:"now"`
	Salt   string  `json:"salt"`
	Consts struct {
		ClaudeArgs    []string `json:"claudeArgs"`
		ClaudeTimeout int      `json:"claudeTimeout"`
		CodexArgs     []string `json:"codexArgs"`
		CodexTimeout  int      `json:"codexTimeout"`
		GrokArgs      []string `json:"grokArgs"`
		GrokTimeout   int      `json:"grokTimeout"`
		ClaudeEnv     string   `json:"claudeEnv"`
	} `json:"consts"`
	MapCases []struct {
		Input    json.RawMessage `json:"input"`
		Out      string          `json:"out"`
		PlanKind string          `json:"planKind"`
	} `json:"mapCases"`
	AuthCases []struct {
		Code *float64 `json:"code"`
		Msg  string   `json:"msg"`
		Out  bool     `json:"out"`
	} `json:"authCases"`
	GrokParse []struct {
		Input json.RawMessage `json:"input"`
		Out   string          `json:"out"`
	} `json:"grokParse"`
	Parses map[string]string `json:"parses"`
	Claude []subsScenario    `json:"claude"`
	Codex  []subsScenario    `json:"codex"`
	Grok   []subsScenario    `json:"grok"`
}

func loadSubsGolden(t *testing.T) subsGolden {
	t.Helper()
	path, _ := paritytest.Golden(t, "usage-subs.json", "testdata/usage-subs.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g subsGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func mustParse(t *testing.T, raw []byte) any {
	t.Helper()
	v, err := util.ParseString(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// outcomeJSON = JSON.stringify(outcome)；withIdentity：codex 的 ok 结果总带 identity 键。
func outcomeJSON(o FetchOutcome, withIdentity bool) string {
	if o.Kind != "ok" {
		return util.Stringify(util.NewObj("kind", o.Kind, "reason", o.Reason))
	}
	r := util.NewObj("kind", o.Kind, "reading", o.Reading.ToObj())
	if withIdentity {
		if o.Identity == nil {
			r.Set("identity", nil)
		} else {
			r.Set("identity", *o.Identity)
		}
	}
	return util.Stringify(r)
}

func TestSubsConstsParity(t *testing.T) {
	g := loadSubsGolden(t)
	eq := func(name string, a, b any) {
		if util.Stringify(a) != util.Stringify(b) {
			t.Errorf("%s: go %s node %s", name, util.Stringify(a), util.Stringify(b))
		}
	}
	eq("claudeArgs", ClaudeUsageArgs, g.Consts.ClaudeArgs)
	eq("codexArgs", CodexAppServerArgs, g.Consts.CodexArgs)
	eq("grokArgs", GrokBillingArgs, g.Consts.GrokArgs)
	eq("timeouts", []int{ClaudeUsageTimeoutMs, CodexRPCTimeoutMs, GrokBillingTimeoutMs},
		[]int{g.Consts.ClaudeTimeout, g.Consts.CodexTimeout, g.Consts.GrokTimeout})
	env := ClaudeUsageEnv(util.NewObj("A", "1", "NO_COLOR", "0", "DISABLE_TELEMETRY", "x"))
	if got := util.Stringify(env); got != g.Consts.ClaudeEnv {
		t.Errorf("claudeUsageEnv: go %s node %s", got, g.Consts.ClaudeEnv)
	}
}

func TestMapCodexRateLimitsParity(t *testing.T) {
	g := loadSubsGolden(t)
	for i, c := range g.MapCases {
		r, id, ok := MapCodexRateLimits(mustParse(t, c.Input), g.Now+float64(i), g.Salt)
		got := "null"
		if ok {
			o := util.NewObj("reading", r.ToObj())
			if id == nil {
				o.Set("identity", nil)
			} else {
				o.Set("identity", *id)
			}
			got = util.Stringify(o)
		}
		if got != c.Out {
			t.Errorf("map[%d] %s:\n go   %s\n node %s", i, c.Input, got, c.Out)
		}
		if k := planKindOf(r); k != c.PlanKind {
			t.Errorf("map[%d] planKind: go %s node %s", i, k, c.PlanKind)
		}
	}
	for i, c := range g.AuthCases {
		if got := IsCodexAuthError(c.Code, c.Msg); got != c.Out {
			t.Errorf("auth[%d] %v %q: go %v node %v", i, c.Code, c.Msg, got, c.Out)
		}
	}
}

func TestParseGrokBillingParity(t *testing.T) {
	g := loadSubsGolden(t)
	for i, c := range g.GrokParse {
		got := "null"
		if r := ParseGrokBilling(mustParse(t, c.Input), g.Now+float64(i)); r != nil {
			got = util.Stringify(r.ToObj())
		}
		if got != c.Out {
			t.Errorf("grokParse[%d] %s:\n go   %s\n node %s", i, c.Input, got, c.Out)
		}
	}
}

/* ---------------- 子进程场景 ---------------- */

var subsEnvSkip = regexp.MustCompile(`^(NO_COLOR|DISABLE_|MOCK_)`)

type subsHarness struct {
	t    *testing.T
	g    subsGolden
	bin  string
	tmp  string
	logs string
	logN int
}

func newSubsHarness(t *testing.T) *subsHarness {
	if _, err := exec.LookPath("node"); err != nil {
		paritytest.SkipOrFail(t, "node not found")
	}
	g := loadSubsGolden(t)
	dir := paritytest.RepoPath("scripts/parity")
	bin := filepath.Join(dir, "usage-mock-cli")
	if runtime.GOOS == "windows" {
		bin += ".cmd"
	}
	if _, err := os.Stat(bin); err != nil {
		paritytest.SkipOrFail(t, "mock cli missing", err)
	}
	mk := func(p string) string {
		d, err := os.MkdirTemp("", p)
		if err != nil {
			t.Fatal(err)
		}
		d, _ = filepath.EvalSymlinks(d)
		return d
	}
	h := &subsHarness{t: t, g: g, bin: bin, tmp: mk("nomi-subs-"), logs: mk("nomi-subs-log-")}
	// 同 record-usage-subs.mjs：先等 mock 子进程（含被超时 / 取消的孙进程）退出，再带重试删除临时目录
	t.Cleanup(func() {
		waitMockChildrenExit(t, h.logs, 30*time.Second)
		for _, d := range []string{h.tmp, h.logs} {
			if err := removeAllRetry(d, 20, 250*time.Millisecond); err != nil {
				t.Errorf("cleanup %s: %v", d, err)
			}
		}
	})
	return h
}

// waitMockChildrenExit：读 usage-mock-cli 写的 <MOCK_LOG>.pid，轮询直到全部退出；超时则强杀
func waitMockChildrenExit(t *testing.T, logDir string, d time.Duration) {
	var pids []int
	ents, _ := os.ReadDir(logDir)
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".pid") {
			continue
		}
		b, _ := os.ReadFile(filepath.Join(logDir, e.Name()))
		for _, ln := range strings.Split(string(b), "\n") {
			if n, err := strconv.Atoi(strings.TrimSpace(ln)); err == nil && n > 0 {
				pids = append(pids, n)
			}
		}
	}
	end := time.Now().Add(d)
	for {
		live := pids[:0]
		for _, p := range pids {
			if pidAlive(p) {
				live = append(live, p)
			}
		}
		pids = live
		if len(pids) == 0 || time.Now().After(end) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, p := range pids {
		t.Logf("waitMockChildrenExit: pid %d still alive after %v, killing", p, d)
		if pr, err := os.FindProcess(p); err == nil {
			_ = pr.Kill()
		}
	}
}

func removeAllRetry(d string, n int, delay time.Duration) error {
	var err error
	for i := 0; i <= n; i++ {
		if err = os.RemoveAll(d); err == nil {
			if _, e := os.Stat(d); os.IsNotExist(e) {
				return nil
			}
			err = fmt.Errorf("still exists")
		}
		time.Sleep(delay)
	}
	return err
}

func (h *subsHarness) resolve(sc subsScenario) func() (string, bool) {
	return func() (string, bool) {
		switch {
		case sc.Name == "not-installed":
			return "", false
		case sc.Name == "resolve-throws":
			panic(jsrt.JSThrow{Message: "boom"})
		case sc.Name == "enoent":
			return filepath.Join(filepath.Dir(h.bin), "no-such-usage-cli"), true
		}
		return h.bin, true
	}
}

func (h *subsHarness) env(sc subsScenario, logf string) func() *util.Obj {
	return func() *util.Obj {
		o := util.NewObj()
		for _, kv := range os.Environ() {
			k, v, _ := strings.Cut(kv, "=")
			if k == "" || subsEnvSkip.MatchString(k) {
				continue
			}
			o.Set(k, v)
		}
		plan := string(sc.Plan)
		if plan == "" || plan == "null" {
			plan = "{}"
		}
		// MOCK_PLAN = JSON.stringify(plan)：按录制的键序重新序列化
		o.Set("MOCK_PLAN", util.Stringify(mustParse(h.t, []byte(plan))))
		o.Set("MOCK_LOG", logf)
		o.Set("MOCK_X", "x1")
		return o
	}
}

func (h *subsHarness) check(kind string, sc subsScenario, outs []string, logf string) {
	t := h.t
	time.Sleep(700 * time.Millisecond)
	if outs != nil && util.Stringify(outs) != util.Stringify(sc.Outs) {
		t.Errorf("%s/%s outcome:\n go   %v\n node %v", kind, sc.Name, outs, sc.Outs)
	}
	// 先等 mock 子进程退出（日志落盘）再比日志（与录制器 logAndLeft 顺序一致）
	left := h.takeLeftovers()
	h.checkLog(kind, sc, logf)
	if runtime.GOOS == "windows" {
		// Windows：Node 与 Go 都在 killTree 后立刻 rmSync，子进程句柄未释放时 EBUSY 被吞，
		// 是否残留取决于时序（docs/design/migrate-2.0.5-go.md §3.4）；只校验残留都属于本 fetcher 的前缀。
		pre := subsTmpPrefix[kind]
		for _, l := range append(append([]string{}, left...), sc.Left...) {
			if l != pre {
				t.Errorf("%s/%s leftovers: unexpected %q (go %v node %v)", kind, sc.Name, l, left, sc.Left)
			}
		}
		if util.Stringify(left) != util.Stringify(sc.Left) {
			t.Logf("%s/%s leftovers differ by Windows rm/exit timing: go %v node %v", kind, sc.Name, left, sc.Left)
		}
		return
	}
	if util.Stringify(left) != util.Stringify(sc.Left) {
		t.Errorf("%s/%s leftovers: go %v node %v", kind, sc.Name, left, sc.Left)
	}
}

var subsTmpPrefix = map[string]string{
	"claude": "nomi-claude-usage-", "codex": "nomi-codex-usage-", "grok": "nomi-grok-billing-", "grokAuth": "nomi-grok-auth-",
}

// takeLeftovers = 录制器 leftovers()：等/杀 mock 子进程，按前缀（去掉 6 位随机后缀）记录本场景残留后删掉。
func (h *subsHarness) takeLeftovers() []string {
	waitMockChildrenExit(h.t, h.logs, 2*time.Second)
	ents, _ := os.ReadDir(h.tmp)
	left := []string{}
	for _, e := range ents {
		n := e.Name()
		_ = removeAllRetry(filepath.Join(h.tmp, n), 20, 250*time.Millisecond)
		if len(n) > 6 {
			n = n[:len(n)-6]
		}
		left = append(left, n)
	}
	sort.Strings(left)
	return left
}

func (h *subsHarness) checkLog(kind string, sc subsScenario, logf string) {
	t := h.t
	var got []string
	if b, err := os.ReadFile(logf); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if l == "" {
				continue
			}
			o := mustParse(t, []byte(l)).(*util.Obj)
			if o.Get("cwdParent") == filepath.Base(h.tmp) {
				o.Set("cwdParent", "<T>")
			}
			got = append(got, util.Stringify(o))
		}
	}
	var want []string
	for _, l := range sc.Log {
		want = append(want, util.Stringify(mustParse(t, l)))
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("%s/%s mock log:\n go   %s\n node %s", kind, sc.Name, strings.Join(got, "\n      "), strings.Join(want, "\n      "))
	}
}

func (h *subsHarness) logFile() string {
	h.logN++
	return filepath.Join(h.logs, fmt.Sprintf("l%d.jsonl", h.logN))
}

func toClaudeParse(t *testing.T, s string) ClaudeUsageParse {
	var p struct {
		Windows     []qWin `json:"windows"`
		Denied      bool   `json:"denied"`
		IsError     bool   `json:"isError"`
		Unsupported bool   `json:"unsupported"`
	}
	if err := json.Unmarshal([]byte(s), &p); err != nil {
		t.Fatal(err)
	}
	ws := make([]QuotaWindow, len(p.Windows))
	for i, w := range p.Windows {
		ws[i] = w.toWin()
	}
	return ClaudeUsageParse{Windows: ws, Denied: p.Denied, IsError: p.IsError, Unsupported: p.Unsupported}
}

func timeoutOr(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func TestClaudeUsageFetcherParity(t *testing.T) {
	h := newSubsHarness(t)
	old := ParseClaudeUsageResultFn
	t.Cleanup(func() { ParseClaudeUsageResultFn = old })
	// claudeUsageParser 归另一模块：回放 Node 对同一 stdout 的解析结果
	ParseClaudeUsageResultFn = func(stdout string, now float64) ClaudeUsageParse {
		s, ok := h.g.Parses[stdout]
		if !ok || now != h.g.Now {
			panic(jsrt.JSThrow{Name: "Error", Message: "unrecorded stdout"})
		}
		return toClaudeParse(t, s)
	}
	for _, sc := range h.g.Claude {
		logf := h.logFile()
		var outs []string
		var unsupported bool
		jsrt.Run(func() {
			f := NewClaudeUsageFetcher(ClaudeFetcherDeps{
				ResolveBin: h.resolve(sc),
				Env:        func() *util.Obj { return ClaudeUsageEnv(h.env(sc, logf)()) },
				TmpRoot:    h.tmp,
				Now:        func() float64 { return h.g.Now },
				TimeoutMs:  timeoutOr(sc.TimeoutMs, 15_000),
			})
			n := 1
			if sc.Twice {
				n = 2
			}
			for i := 0; i < n; i++ {
				o, _ := jsrt.Await(f.Fetch(sc.FetchPlan))
				outs = append(outs, outcomeJSON(o, false))
			}
			unsupported = f.IsUnsupported()
		})
		if unsupported != sc.Unsupported {
			t.Errorf("claude/%s isUnsupported: go %v node %v", sc.Name, unsupported, sc.Unsupported)
		}
		h.check("claude", sc, outs, logf)
	}
}

func TestCodexRateLimitReaderParity(t *testing.T) {
	h := newSubsHarness(t)
	for _, sc := range h.g.Codex {
		logf := h.logFile()
		var outs []string
		jsrt.Run(func() {
			d := CodexRPCDeps{
				ResolveBin:    h.resolve(sc),
				Env:           h.env(sc, logf),
				TmpRoot:       h.tmp,
				Now:           func() float64 { return h.g.Now },
				TimeoutMs:     timeoutOr(sc.TimeoutMs, 15_000),
				Salt:          func() string { return h.g.Salt },
				ClientVersion: sc.ClientVersion,
			}
			if sc.ExtraArgs != nil {
				d.ExtraArgs = func() []string { return sc.ExtraArgs }
			}
			o, _ := jsrt.Await(NewCodexRateLimitReader(d).Fetch())
			outs = append(outs, outcomeJSON(o, true))
			if k := planKindOf(o.Reading); k != sc.PlanKind {
				t.Errorf("codex %s planKind: go %s node %s", sc.Name, k, sc.PlanKind)
			}
		})
		h.check("codex", sc, outs, logf)
	}
}

func TestGrokBillingFetcherParity(t *testing.T) {
	h := newSubsHarness(t)
	for _, sc := range h.g.Grok {
		logf := h.logFile()
		var outs []string
		jsrt.Run(func() {
			f := NewGrokBillingFetcher(GrokBillingDeps{
				ResolveBin: h.resolve(sc),
				Env:        h.env(sc, logf),
				TmpRoot:    h.tmp,
				Now:        func() float64 { return h.g.Now },
				TimeoutMs:  timeoutOr(sc.TimeoutMs, 15_000),
			})
			n := 1
			if sc.Twice {
				n = 2
			}
			for i := 0; i < n; i++ {
				o, _ := jsrt.Await(f.Fetch())
				outs = append(outs, outcomeJSON(o, false))
			}
		})
		h.check("grok", sc, outs, logf)
	}
}
