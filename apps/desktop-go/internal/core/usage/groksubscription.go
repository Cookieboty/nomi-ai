package usage

// groksubscription.go = packages/core/src/usage/grokSubscription.ts
//
// Grok 账户额度：官方 Grok CLI 在 ACP 中提供 `_x.ai/billing` 扩展。让 CLI 自己读取登录态，
// 只保留账户周期的百分比、周期时间和套餐名；Nomi 不读 auth.json，也不把 billing 原始响应写入日志或磁盘。

import (
	"math"
	"os"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

var GrokBillingArgs = []string{"agent", "stdio"}

const GrokBillingTimeoutMs = 15_000

func grokDateMs(v any) (float64, bool) {
	s, ok := v.(string)
	if !ok || util.JSTrim(s) == "" {
		return 0, false
	}
	n, ok := reminders.DateParse(s)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return n, true
}

// ParseGrokBilling = parseGrokBilling（nil = null）。
func ParseGrokBilling(raw any, now float64) *QuotaReading {
	root := recObj(raw)
	var config, period *util.Obj
	if root != nil {
		config = recObj(root.Get("config"))
	}
	if config != nil {
		period = recObj(config.Get("currentPeriod"))
	}
	used := math.NaN()
	if config != nil {
		switch u := config.Get("creditUsagePercent").(type) {
		case float64:
			used = u
		case string:
			if util.JSTrim(u) != "" {
				used = util.ToNumber(u)
			}
		}
	}
	if math.IsNaN(used) || math.IsInf(used, 0) || used < 0 {
		return nil
	}
	usedPercent := math.Min(100, used)
	var ps, pe, pt any
	if period != nil {
		ps, pe, pt = period.Get("start"), period.Get("end"), period.Get("type")
	}
	start, ok1 := grokDateMs(ps)
	end, ok2 := grokDateMs(pe)
	if !ok1 || !ok2 || end <= start {
		return nil
	}
	typ, _ := pt.(string)
	id := typ
	if id == "" {
		id = "current-period"
	}
	wm := math.Max(1, jsRound((end-start)/60_000))
	tier := ""
	if root != nil {
		if s, ok := root.Get("subscription_tier").(string); ok {
			tier = util.JSTrim(s)
		}
	}
	return &QuotaReading{
		Windows:   []QuotaWindow{{ID: id, UsedPercent: usedPercent, WindowMinutes: f64p(wm), ResetAt: f64p(end)}},
		UpdatedAt: now, Origin: "grok-acp", Plan: tier,
	}
}

// GrokBillingDeps = GrokBillingDeps（零值字段 = 默认）。
type GrokBillingDeps struct {
	ResolveBin func() (string, bool)
	SpawnFn    func(file string, args []string, o nodeproc.Options) *nodeproc.Child
	Env        func() *util.Obj
	TmpRoot    string
	Now        func() float64
	TimeoutMs  int
	Platform   string
}

// GrokBillingFetcher = class GrokBillingFetcher。
type GrokBillingFetcher struct {
	d           GrokBillingDeps
	unsupported bool
}

func NewGrokBillingFetcher(d GrokBillingDeps) *GrokBillingFetcher { return &GrokBillingFetcher{d: d} }

// Fetch = async fetch()。须在 jsrt 线程内调用。
func (g *GrokBillingFetcher) Fetch() *jsrt.Promise[FetchOutcome] {
	return jsrt.Async(func() (FetchOutcome, error) { return g.fetch(), nil })
}

type grokBillingResult struct {
	raw      any
	hasRaw   bool
	errObj   *util.Obj
	timedOut bool
}

func (g *GrokBillingFetcher) fetch() (out FetchOutcome) {
	if g.unsupported {
		return FetchOutcome{Kind: "transient", Reason: "unsupported"}
	}
	bin := resolveBinSafe(g.d.ResolveBin, DefaultGrokBin)
	if bin == "" {
		return FetchOutcome{Kind: "transient", Reason: "not-installed"}
	}
	root := g.d.TmpRoot
	if root == "" {
		root = os.TempDir()
	}
	dir, err := NodeMkdtemp(filepath.Join(root, "nomi-grok-billing-"))
	if err != nil {
		panic(jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "mkdtemp", filepath.Join(root, "nomi-grok-billing-XXXXXX"))})
	}
	var env *util.Obj
	switch {
	case g.d.Env != nil:
		env = g.d.Env()
	case DefaultCliEnv != nil:
		env = DefaultCliEnv()
	default:
		env = ProcessEnv()
	}
	platform := g.d.Platform
	if platform == "" {
		platform = Platform()
	}
	launch := ResolveCliLaunch(bin, GrokBillingArgs, env, platform, UnwrapCmdDeps{})
	if launch == nil {
		_ = nodefs.RmForce(dir)
		return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
	}
	var child *nodeproc.Child
	defer func() {
		if child != nil {
			KillTree(child, 200)
		}
		_ = nodefs.RmForce(dir)
	}()
	defer func() {
		if r := recover(); r != nil {
			out = FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
		}
	}()
	sp := g.d.SpawnFn
	if sp == nil {
		sp = nodeproc.Spawn
	}
	childEnv := env.Clone()
	childEnv.Set("NO_COLOR", "1")
	func() {
		defer func() {
			if r := recover(); r != nil {
				child = nil
			}
		}()
		child = sp(launch.File, launch.Args, nodeproc.Options{Cwd: dir, Env: EnvSlice(childEnv), IgnoreStderr: true, Verbatim: launch.Via == ViaCmdShim})
	}()
	// 让出期间 jsrt 可能先跑 spawn 失败的 'error' 宏任务（Node 里 await 只让出微任务，error 一定在挂监听之后）：
	// 先记下，挂好监听后补发，结果确定。
	earlyErr, hooked := false, false
	if child != nil {
		child.OnError(func(error) {
			if !hooked {
				earlyErr = true
			}
		})
	}
	// child = await new Promise(...)：即使同步 resolve，await 也让出一次
	jsrt.Await(jsrt.Resolved(struct{}{}))
	if child == nil {
		return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
	}
	var now float64
	if g.d.Now != nil {
		now = g.d.Now()
	} else {
		now = nowMs()
	}
	p := jsrt.NewPromise[grokBillingResult]()
	settled := false
	bytes := 0
	buf := ""
	var timer *jsrt.Timer
	finish := func(v grokBillingResult) {
		if settled {
			return
		}
		settled = true
		jsrt.ClearTimeout(timer)
		p.Resolve(v)
	}
	to := g.d.TimeoutMs
	if to == 0 {
		to = GrokBillingTimeoutMs
	}
	timer = jsrt.SetTimeout(time.Duration(to)*time.Millisecond, func() { finish(grokBillingResult{timedOut: true}) })
	child.OnError(func(error) { finish(grokBillingResult{}) })
	child.OnClose(func(*int, string) { finish(grokBillingResult{}) })
	hooked = true
	if earlyErr {
		finish(grokBillingResult{})
	}
	billingSent := false
	send := func(m *util.Obj) {
		if child.Stdin != nil {
			child.Stdin.Write(util.Stringify(m) + "\n")
		}
	}
	child.OnStdout(func(s string) {
		bytes += len(s) // Buffer.byteLength
		if bytes > StdoutLimit {
			finish(grokBillingResult{})
			return
		}
		buf += s
		for {
			i := indexByteStr(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+1:]
			v, err := util.ParseString(line)
			if err != nil {
				continue
			}
			m, _ := v.(*util.Obj) // message?.id 对数组 / 原始值都是 undefined
			if m == nil {
				continue
			}
			id, _ := m.Get("id").(float64)
			hasID := false
			if _, ok := m.Get("id").(float64); ok {
				hasID = true
			}
			e := m.Get("error")
			eObj := isJSObject(e)
			if hasID && id == 1 && util.Truthy(e) && eObj != nil {
				finish(grokBillingResult{errObj: eObj})
				return
			}
			if hasID && id == 1 && util.Truthy(m.Get("result")) && !billingSent {
				billingSent = true
				send(util.NewObj("jsonrpc", "2.0", "method", "initialized", "params", util.NewObj()))
				send(util.NewObj("jsonrpc", "2.0", "id", float64(2), "method", "_x.ai/billing", "params", util.NewObj()))
			} else if hasID && id == 2 {
				if util.Truthy(e) && eObj != nil {
					finish(grokBillingResult{errObj: eObj})
				} else {
					finish(grokBillingResult{raw: m.Get("result"), hasRaw: true})
				}
				return
			}
		}
	})
	send(util.NewObj("jsonrpc", "2.0", "id", float64(1), "method", "initialize", "params",
		util.NewObj("protocolVersion", float64(1),
			"clientInfo", util.NewObj("name", "nomi_usage", "title", "Nomi", "version", "1.0.0"),
			"clientCapabilities", util.NewObj())))
	result, _ := jsrt.Await(p)
	if result.timedOut {
		return FetchOutcome{Kind: "transient", Reason: "timeout"}
	}
	if result.errObj != nil {
		if c, ok := result.errObj.Get("code").(float64); ok && c == -32601 {
			g.unsupported = true
			return FetchOutcome{Kind: "transient", Reason: "unsupported"}
		}
		return FetchOutcome{Kind: "transient", Reason: "network"}
	}
	if reading := ParseGrokBilling(result.raw, now); reading != nil {
		return FetchOutcome{Kind: "ok", Reading: reading}
	}
	return FetchOutcome{Kind: "transient", Reason: "no-limits"}
}

// isJSObject：typeof v === 'object' 且非 null（数组也算；数组没有 .code，结果同普通对象）。
func isJSObject(v any) *util.Obj {
	switch x := v.(type) {
	case *util.Obj:
		return x
	case []any:
		return util.NewObj()
	}
	return nil
}
