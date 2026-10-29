package usage

// codexratelimits.go = packages/core/src/usage/codexRateLimits.ts
//
// Codex 额度：拉起官方 `codex app-server`，通过官方 JSON-RPC `account/rateLimits/read` 读取。
// 登录凭据始终留在 Codex 自己手里，Nomi 不读 auth.json、不经手任何 token。
//
// 握手：
//   → {"id":1,"method":"initialize","params":{"clientInfo":{"name":…,"title":…,"version":…}}}
//   ← {"id":1,"result":{…}}
//   → {"method":"initialized"}
//   → {"id":2,"method":"account/rateLimits/read"}
//   ← （没有 id 的通知一律忽略）{"id":2,"result":{"rateLimits":{…}}}
// 受限：`codex -s read-only -a never -c analytics.enabled=false app-server`；cwd 为空临时目录；
// stdout 总量 / 行缓冲 256K（UTF-16 单位）；超时 20 秒；stderr 丢弃；读完关 stdin 并终止进程。

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

var CodexAppServerArgs = []string{"-s", "read-only", "-a", "never", "-c", "analytics.enabled=false", "app-server"}

const CodexRPCTimeoutMs = 20_000

var codexPlanLabel = map[string]string{
	"free": "Free", "go": "Go", "plus": "Plus", "pro": "Pro", "prolite": "Pro Lite", "promax": "Pro Max",
	"team": "Team", "business": "Business", "enterprise": "Enterprise", "edu": "Edu",
}

// Object.prototype 上的键：PLAN_LABEL[k] 取到函数（非 nullish、JSON 序列化时丢弃）——等同不带 plan。
var objectProtoKeys = map[string]bool{
	"constructor": true, "hasOwnProperty": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"toLocaleString": true, "toString": true, "valueOf": true, "__defineGetter__": true,
	"__defineSetter__": true, "__lookupGetter__": true, "__lookupSetter__": true,
}

// numFinite = num()：有限 number。
func numFinite(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// recObj = rec()：非 null、非数组对象。
func recObj(v any) *util.Obj {
	o, _ := v.(*util.Obj)
	return o
}

// MapCodexRateLimits = mapCodexRateLimits（ok=false = null；identity nil = null）。
func MapCodexRateLimits(result any, now float64, salt string) (reading *QuotaReading, identity *string, ok bool) {
	r := recObj(result)
	if r == nil {
		return nil, nil, false
	}
	var snap *util.Obj
	if byID := recObj(r.Get("rateLimitsByLimitId")); byID != nil {
		snap = recObj(byID.Get("codex"))
	}
	if snap == nil {
		snap = recObj(r.Get("rateLimits"))
	}
	if snap == nil {
		return nil, nil, false
	}
	windows := []QuotaWindow{}
	for _, id := range []string{"primary", "secondary"} {
		w := recObj(snap.Get(id))
		if w == nil {
			continue
		}
		used, uok := numFinite(w.Get("usedPercent"))
		if !uok || used < 0 {
			continue
		}
		qw := QuotaWindow{ID: id, UsedPercent: math.Min(100, used)}
		if mins, ok := numFinite(w.Get("windowDurationMins")); ok && mins != 0 && mins > 0 {
			qw.WindowMinutes = f64p(mins)
		}
		if at, ok := numFinite(w.Get("resetsAt")); ok && at != 0 && at > 0 {
			if at < 1e11 {
				at *= 1000
			}
			qw.ResetAt = f64p(at)
		}
		windows = append(windows, qw)
	}
	if len(windows) == 0 {
		return nil, nil, false
	}
	plan := ""
	if pr, ok := snap.Get("planType").(string); ok && pr != "" && pr != "unknown" {
		if l, ok := codexPlanLabel[pr]; ok {
			plan = l
		} else if !objectProtoKeys[pr] {
			plan = pr
		}
	}
	var acc *string
	if s, ok := r.Get("accountId").(string); ok {
		acc = &s
	}
	reading = &QuotaReading{Windows: windows, UpdatedAt: now, Origin: "app-server", Plan: plan}
	if fp, ok := Fingerprint(salt, []*string{acc}); ok {
		identity = &fp
	}
	return reading, identity, true
}

var (
	codexAuthRe1 = regexp.MustCompile(`authentication required`)
	codexAuthRe2 = regexp.MustCompile(`not logged in|log in|sign in|signed in|unauthorized`)
	chatgptRe    = regexp.MustCompile(`(?i)chatgpt`)
)

// IsCodexAuthError = isCodexAuthError（code nil = undefined）。
func IsCodexAuthError(code *float64, message string) bool {
	m := util.JSLower(message)
	return codexAuthRe1.MatchString(m) || codexAuthRe2.MatchString(m) || (code != nil && *code == 401)
}

// codexRPCError = class RpcError。
type codexRPCError struct {
	kind       string // rpc | timeout | output-limit | closed | spawn
	code       *float64
	rpcMessage string
}

func (e *codexRPCError) Error() string { return e.kind }

// CodexRPCDeps = CodexRpcDeps（零值字段 = 默认；Salt 必填）。
type CodexRPCDeps struct {
	ResolveBin    func() (string, bool)
	SpawnFn       func(file string, args []string, o nodeproc.Options) *nodeproc.Child
	Env           func() *util.Obj
	ExtraArgs     func() []string
	TmpRoot       string
	Now           func() float64
	TimeoutMs     int
	Salt          func() string
	Platform      string
	ClientVersion string
}

// CodexRateLimitReader = class CodexRateLimitReader。
type CodexRateLimitReader struct{ d CodexRPCDeps }

func NewCodexRateLimitReader(d CodexRPCDeps) *CodexRateLimitReader {
	return &CodexRateLimitReader{d: d}
}

// Fetch = async fetch()。须在 jsrt 线程内调用。
func (c *CodexRateLimitReader) Fetch() *jsrt.Promise[FetchOutcome] {
	return jsrt.Async(func() (FetchOutcome, error) { return c.fetch(), nil })
}

func (c *CodexRateLimitReader) fetch() (out FetchOutcome) {
	bin := resolveBinSafe(c.d.ResolveBin, DefaultCodexBin)
	if bin == "" {
		return FetchOutcome{Kind: "transient", Reason: "not-installed"}
	}
	root := c.d.TmpRoot
	if root == "" {
		root = os.TempDir()
	}
	dir, err := NodeMkdtemp(filepath.Join(root, "nomi-codex-usage-"))
	if err != nil {
		panic(jsrt.JSThrow{Name: "Error", Message: nodefs.Message(err, "mkdtemp", filepath.Join(root, "nomi-codex-usage-XXXXXX"))})
	}
	var child *nodeproc.Child
	defer func() {
		if child != nil {
			func() { defer func() { _ = recover() }(); child.Stdin.End() }()
			KillTree(child, 500)
		}
		_ = nodefs.RmForce(dir)
	}()
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(*codexRPCError); ok {
				out = codexOutcome(e)
				return
			}
			out = FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
		}
	}()
	var env *util.Obj
	switch {
	case c.d.Env != nil:
		env = c.d.Env()
	case DefaultCliEnv != nil:
		env = DefaultCliEnv()
	default:
		env = ProcessEnv()
	}
	platform := c.d.Platform
	if platform == "" {
		platform = Platform()
	}
	file := bin
	var args []string
	if c.d.ExtraArgs != nil {
		args = append(args, c.d.ExtraArgs()...)
	}
	args = append(args, CodexAppServerArgs...)
	if platform == "win32" && cmdBatRe.MatchString(bin) {
		f, a, ok := WindowsShimLaunch(bin, args, env)
		if !ok {
			return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
		}
		file, args = f, a
	}
	sp := c.d.SpawnFn
	if sp == nil {
		sp = nodeproc.Spawn
	}
	spawnPanicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				spawnPanicked = true
				child = nil
			}
		}()
		child = sp(file, args, nodeproc.Options{Cwd: dir, Env: EnvSlice(env), IgnoreStderr: true, Verbatim: file != bin})
	}()
	if spawnPanicked || child == nil {
		return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
	}
	result, err := jsrt.Await(c.session(child))
	if err != nil {
		if e, ok := err.(*codexRPCError); ok {
			return codexOutcome(e)
		}
		return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
	}
	var now float64
	if c.d.Now != nil {
		now = c.d.Now()
	} else {
		now = nowMs()
	}
	reading, identity, ok := MapCodexRateLimits(result, now, c.d.Salt())
	if !ok {
		return FetchOutcome{Kind: "transient", Reason: "no-limits"}
	}
	return FetchOutcome{Kind: "ok", Reading: reading, Identity: identity}
}

func codexOutcome(e *codexRPCError) FetchOutcome {
	switch e.kind {
	case "timeout":
		return FetchOutcome{Kind: "transient", Reason: "timeout"}
	case "output-limit":
		return FetchOutcome{Kind: "transient", Reason: "output-limit"}
	case "spawn":
		if e.code != nil && *e.code == -2 {
			return FetchOutcome{Kind: "transient", Reason: "not-installed"}
		}
		return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
	case "rpc":
		if IsCodexAuthError(e.code, e.rpcMessage) {
			if chatgptRe.MatchString(e.rpcMessage) {
				return FetchOutcome{Kind: "auth", Reason: "api-account"}
			}
			return FetchOutcome{Kind: "auth", Reason: "not-signed-in"}
		}
		return FetchOutcome{Kind: "transient", Reason: "bad-output"}
	}
	return FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
}

type codexPending struct {
	resolve func(any)
	reject  func(*codexRPCError)
}

// session：握手 + 读额度；返回 account/rateLimits/read 的 result（原始）。
func (c *CodexRateLimitReader) session(child *nodeproc.Child) *jsrt.Promise[any] {
	p := jsrt.NewPromise[any]()
	pending := map[float64]codexPending{}
	var pendingOrder []float64
	buf := ""
	total := 0
	done := false
	var timer *jsrt.Timer
	fail := func(e *codexRPCError) {
		if done {
			return
		}
		done = true
		jsrt.ClearTimeout(timer)
		for _, id := range pendingOrder {
			if pp, ok := pending[id]; ok {
				pp.reject(e)
			}
		}
		p.Reject(e)
	}
	to := c.d.TimeoutMs
	if to == 0 {
		to = CodexRPCTimeoutMs
	}
	timer = jsrt.SetTimeout(time.Duration(to)*time.Millisecond, func() { fail(&codexRPCError{kind: "timeout"}) })
	send := func(o *util.Obj) {
		if child.Stdin != nil {
			child.Stdin.Write(util.Stringify(o) + "\n")
		}
	}
	request := func(id float64, method string, params any, onOK func(any), onErr func(*codexRPCError)) {
		pending[id] = codexPending{resolve: onOK, reject: onErr}
		pendingOrder = append(pendingOrder, id)
		o := util.NewObj("id", id, "method", method)
		if params != nil {
			o.Set("params", params)
		}
		send(o)
	}
	onLine := func(line string) {
		if util.JSTrim(line) == "" {
			return
		}
		v, err := util.ParseString(line)
		if err != nil {
			return
		}
		m := recObj(v)
		if m == nil {
			return
		}
		id, ok := m.Get("id").(float64)
		if !ok {
			return
		}
		pp, ok := pending[id]
		if !ok {
			return
		}
		delete(pending, id)
		if e := recObj(m.Get("error")); e != nil {
			var code *float64
			if n, ok := numFinite(e.Get("code")); ok {
				code = &n
			}
			msg := ""
			if s, ok := e.Get("message").(string); ok {
				msg = util.UTF16Slice0(s, 300)
			}
			pp.reject(&codexRPCError{kind: "rpc", code: code, rpcMessage: msg})
		} else {
			pp.resolve(m.Get("result"))
		}
	}
	child.OnError(func(e error) {
		var code *float64
		if se, ok := e.(*nodeproc.SpawnError); ok && se.Code == "ENOENT" {
			code = f64p(-2)
		}
		fail(&codexRPCError{kind: "spawn", code: code})
	})
	child.OnClose(func(*int, string) { fail(&codexRPCError{kind: "closed"}) })
	child.OnStdout(func(s string) {
		total += util.UTF16Len(s)
		buf += s
		if total > StdoutLimit || util.UTF16Len(buf) > StdoutLimit {
			fail(&codexRPCError{kind: "output-limit"})
			return
		}
		for {
			i := indexByteStr(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+1:]
			onLine(line)
		}
	})
	// (async () => { await request(1); send(initialized); const r = await request(2); … })().catch(fail)
	// await 的续体是微任务：同一块里 id:1 之后的行先处理完，再发 initialized / id:2。
	asyncFail := func(e *codexRPCError) { jsrt.QueueMicrotask(func() { fail(e) }) }
	version := c.d.ClientVersion
	if version == "" {
		version = "1.0.0"
	}
	request(1, "initialize", util.NewObj("clientInfo", util.NewObj("name", "nomi_usage", "title", "Nomi", "version", version)),
		func(any) {
			jsrt.QueueMicrotask(func() {
				send(util.NewObj("method", "initialized"))
				request(2, "account/rateLimits/read", nil, func(r any) {
					jsrt.QueueMicrotask(func() {
						if !done {
							done = true
							jsrt.ClearTimeout(timer)
							p.Resolve(r)
						}
					})
				}, asyncFail)
			})
		}, asyncFail)
	return p
}

func indexByteStr(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
