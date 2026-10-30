// cli_update_service.go = apps/desktop-electron/internal/core/src/cli/CliUpdateService.ts（CLI 版本检测、安装与白名单更新）。
//
// 安装 / 更新只执行固定 argv 的白名单命令；Windows 的 npm.cmd 例外地经 shell 执行，参数同样来自白名单。
// 所有方法持 jsrt 锁调用；返回 Promise 的方法与 Node 的 async 方法一一对应。
package cli

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodepath"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// UpdateRecipe = UpdateRecipe（Via "self" | "npm"）。
type UpdateRecipe struct {
	Kind string
	Via  string
	Argv []string
}

func cuIsWin() bool { return usage.Platform() == "win32" }

// UserPrefix = userPrefix()。
func UserPrefix() string { return nodepath.Lib(usage.Platform()).Join(usage.Homedir(), ".local") }

func npmCommand() string {
	if e := util.JSTrim(os.Getenv("NOMI_NPM_BIN")); e != "" {
		return e
	}
	if cuIsWin() {
		return "npm.cmd"
	}
	return "npm"
}

// UpdateRecipes = updateRecipes(kind, bin, method, scope)；bin "" = null，scope "" = global。
func UpdateRecipes(kind, bin, method, scope string) []UpdateRecipe {
	if scope == "" {
		scope = "global"
	}
	var recipes []UpdateRecipe
	if bin != "" && kind != "dsh" && kind != "gemini" && (method == "native" || method == "unknown" || kind == "grok") {
		recipes = append(recipes, UpdateRecipe{Kind: kind, Via: "self", Argv: []string{bin, "update"}})
	}
	argv := []string{npmCommand(), "install", "-g", NpmPkg[kind] + "@latest"}
	if scope == "user" {
		argv = append(argv, "--prefix", UserPrefix())
	}
	return append(recipes, UpdateRecipe{Kind: kind, Via: "npm", Argv: argv})
}

var cmdSuffixRe = regexp.MustCompile(`(?i)\.cmd$`)

var allowedPkgs = map[string]bool{
	"@anthropic-ai/claude-code@latest": true, "@openai/codex@latest": true, "@deepseek-ai/dsh@latest": true,
	"@xai-official/grok@latest": true, "@google/gemini-cli@latest": true,
}

// IsAllowedUpdateArgv = isAllowedUpdateArgv。
func IsAllowedUpdateArgv(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	cmd, rest := argv[0], argv[1:]
	base := util.JSLower(cmdSuffixRe.ReplaceAllString(nodepath.Lib(usage.Platform()).Basename(cmd), ""))
	if (base == "claude" || base == "codex" || base == "grok" ||
		strings.HasSuffix(cmd, "claude") || strings.HasSuffix(cmd, "codex") || strings.HasSuffix(cmd, "grok")) &&
		len(rest) == 1 && rest[0] == "update" {
		return true
	}
	envNpm := util.JSTrim(os.Getenv("NOMI_NPM_BIN"))
	if (base == "npm" || (envNpm != "" && cmd == envNpm)) && len(rest) >= 2 && rest[0] == "install" && rest[1] == "-g" {
		pkg := ""
		if len(rest) > 2 {
			pkg = rest[2]
		}
		if !allowedPkgs[pkg] {
			return false
		}
		if len(rest) == 3 {
			return true
		}
		return len(rest) == 5 && rest[3] == "--prefix" && rest[4] == UserPrefix()
	}
	return false
}

// IsUpdatable = isUpdatable。
func IsUpdatable(kind string) bool {
	return kind == "claude" || kind == "codex" || kind == "dsh" || kind == "grok" || kind == "gemini"
}

// ToUpdatable = toUpdatable。
func ToUpdatable(kind any) string {
	if s, ok := kind.(string); ok && (s == "codex" || s == "dsh" || s == "grok" || s == "gemini") {
		return s
	}
	return "claude"
}

// ToScope = toScope。
func ToScope(v any) string {
	if s, ok := v.(string); ok && s == "user" {
		return "user"
	}
	return "global"
}

var plainArgRe = regexp.MustCompile(`^[A-Za-z0-9_@./:\\=+-]+$`)

func quoteArg(a string) string {
	if plainArgRe.MatchString(a) {
		return a
	}
	return `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
}

// CommandLine = commandLine。
func CommandLine(argv []string) string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = quoteArg(a)
	}
	return strings.Join(out, " ")
}

// CliProbe = CliProbe（"" = null）。持锁调用；阻塞部分应释放锁。
type CliProbe interface {
	NodeVersion() string
	NodeBin() string // PATH 上 node 的路径
	NpmBin() string
	NpmPrefix() string
	CanWrite(dir string) bool
}

type defaultCliProbe struct{}

// DefaultCliProbe = defaultProbe。
var DefaultCliProbe CliProbe = defaultCliProbe{}

func (defaultCliProbe) NodeVersion() string { return ReadPathNodeVersionAsync() }
func (defaultCliProbe) NodeBin() string     { return ResolveNodeBin() }
func (defaultCliProbe) NpmBin() string      { return ResolveNpmBinAsync() }
func (defaultCliProbe) NpmPrefix() string {
	npm := ResolveNpmBinAsync()
	if npm == "" {
		return ""
	}
	return offThread(func() string {
		out, err := execText(npm, []string{"config", "get", "prefix"}, WithCliPath(nil), 8000, cuIsWin())
		if err != nil {
			return ""
		}
		lines := regexp.MustCompile(`\r?\n`).Split(util.JSTrim(out), -1)
		return lines[len(lines)-1]
	})
}
func (defaultCliProbe) CanWrite(dir string) bool {
	d := dir
	lib := nodepath.Lib(usage.Platform())
	for i := 0; i < 8 && !usage.ExistsSync(d); i++ {
		d = lib.Dirname(d)
	}
	return accessWritable(d)
}

// CliRunOutput = runner 的结果（Code nil = null）。
type CliRunOutput struct {
	Code   *int
	Output string
}

// CliRunner = CliRunner。
type CliRunner func(argv []string, onLine func(string), timeoutMs int) *jsrt.Promise[CliRunOutput]

var lineSplitRe = regexp.MustCompile(`\r?\n`)

// DefaultCliRunner = defaultRunner。
func DefaultCliRunner(argv []string, onLine func(string), timeoutMs int) *jsrt.Promise[CliRunOutput] {
	p := jsrt.NewPromise[CliRunOutput]()
	env := usage.EnvSlice(WithCliPath(nil))
	var child *nodeproc.Child
	if cuIsWin() && isCmdBat(argv[0]) {
		f, a, verbatim := execOpts(CommandLine(argv), nil, true)
		child = nodeproc.Spawn(f, a, nodeproc.Options{Env: env, Verbatim: verbatim})
	} else {
		child = nodeproc.Spawn(argv[0], argv[1:], nodeproc.Options{Env: env})
	}
	output, pending := "", ""
	feed := func(text string) {
		output = util.UTF16Tail(output+text, 64*1024)
		pending += text
		lines := lineSplitRe.Split(pending, -1)
		pending = lines[len(lines)-1]
		for _, l := range lines[:len(lines)-1] {
			if util.JSTrim(l) != "" {
				onLine(l)
			}
		}
	}
	child.OnStdout(feed)
	child.OnStderr(feed)
	timer := jsrt.SetTimeout(time.Duration(timeoutMs)*time.Millisecond, func() {
		output += "\n" + i18n.T("electron.common.timed-out-and-stopped")
		child.Kill("")
	})
	child.OnError(func(e error) {
		jsrt.ClearTimeout(timer)
		p.Resolve(CliRunOutput{Code: nil, Output: util.JSTrim(output + "\n" + e.Error())})
	})
	child.OnClose(func(code *int, _ string) {
		jsrt.ClearTimeout(timer)
		if util.JSTrim(pending) != "" {
			onLine(pending)
		}
		p.Resolve(CliRunOutput{Code: code, Output: util.JSTrim(output)})
	})
	return p
}

var inspectKinds = []string{"claude", "codex", "dsh", "grok", "gemini", "cursor"}
var latestKinds = []string{"claude", "codex", "dsh", "grok", "gemini"}

const (
	probeTTLMs  = 5 * 60_000
	latestTTLMs = 6 * 60 * 60_000
)

type localProbe struct {
	kind, bin, version string
	runtimeWarning     *DshProblem
}

// CliJob = CliJobSnapshot（内部状态）。
type cliJob struct {
	kind, mode, scope, status string
	argv                      []string
	command                   string
	lines                     []string
	startedAt                 float64
	result                    *util.Obj
	finishedAt                float64
	finished                  bool
}

// CliUpdateLogger = Logger。
type CliUpdateLogger interface {
	Info(m string, d any)
	Warn(m string, d any)
}

// CliUpdateEvents = AppEvents 的 publish 子集。
type CliUpdateEvents interface {
	Publish(event string, payload any)
}

// CliUpdateOptions = 构造参数 d。
type CliUpdateOptions struct {
	Root      string
	Logger    CliUpdateLogger
	Probe     CliProbe
	Runner    CliRunner
	Events    CliUpdateEvents
	Emit      func(payload *util.Obj)
	Platform  string
	Drain     func(kind string) *jsrt.Promise[int]
	OnUpdated func(kind, version string) // version "" = null
}

type probedEntry struct {
	at   float64
	rows *jsrt.Promise[[]localProbe]
}

// CliUpdateService = CliUpdateService。
type CliUpdateService struct {
	d             CliUpdateOptions
	cache         any // JSON.parse 的结果（Node 不校验形状）
	probed        *probedEntry
	latestRefresh *jsrt.Promise[struct{}]
	cachePath     string
	preferredPath string // 用户目录安装成功的 CLI → 可执行文件（重启后仍优先用它，见 PreferCliBin）
	preferred     map[string]string
	jobs          map[string]*cliJob
	inflight      map[string]*jsrt.Promise[*util.Obj]
	inflightOrder []string
	npmQueue      map[string]*jsrt.Promise[struct{}]
	probe         CliProbe
	runner        CliRunner
}

// cuNow = Date.now()（测试可替换）。
var cuNow = func() float64 { return float64(time.Now().UnixMilli()) }

func emptyCuCache() *util.Obj { return util.NewObj("checkedAt", float64(0), "latest", util.NewObj()) }

// NewCliUpdateService = new CliUpdateService(d)。
func NewCliUpdateService(d CliUpdateOptions) (*CliUpdateService, error) {
	s := &CliUpdateService{d: d, jobs: map[string]*cliJob{}, inflight: map[string]*jsrt.Promise[*util.Obj]{}, npmQueue: map[string]*jsrt.Promise[struct{}]{}}
	s.probe = d.Probe
	if s.probe == nil {
		s.probe = DefaultCliProbe
	}
	s.runner = d.Runner
	if s.runner == nil {
		s.runner = DefaultCliRunner
	}
	s.cachePath = filepath.Join(d.Root, "cache.json")
	s.preferredPath = filepath.Join(d.Root, "preferred.json")
	if err := os.MkdirAll(d.Root, 0o777); err != nil {
		return nil, err
	}
	s.load()
	s.loadPreferred()
	return s, nil
}

func (s *CliUpdateService) loadPreferred() {
	s.preferred = map[string]string{}
	if b, err := os.ReadFile(s.preferredPath); err == nil {
		if v, err := util.ParseString(string(b)); err == nil {
			if o, ok := v.(*util.Obj); ok {
				for _, k := range o.Keys() {
					if p, ok := o.Get(k).(string); ok && p != "" && IsUpdatable(k) {
						s.preferred[k] = p
					}
				}
			}
		}
	}
	for k, p := range s.preferred {
		PreferCliBin(k, p)
	}
}

func (s *CliUpdateService) setPreferred(kind, bin string) {
	if s.preferred[kind] == bin {
		return
	}
	if bin != "" {
		s.preferred[kind] = bin
	} else {
		delete(s.preferred, kind)
	}
	PreferCliBin(kind, bin)
	o := util.NewObj()
	for _, k := range []string{"claude", "codex", "dsh", "grok", "gemini"} {
		if p, ok := s.preferred[k]; ok {
			o.Set(k, p)
		}
	}
	if err := os.WriteFile(s.preferredPath, []byte(util.StringifyIndent(o, "  ")), 0o666); err != nil {
		s.d.Logger.Warn("cli-update preferred save failed", err)
	}
}

// userBin：用户目录前缀里这个 CLI 的可执行文件（"" = 没有）
func (s *CliUpdateService) userBin(kind string) string {
	platform := s.d.Platform
	if platform == "" {
		platform = usage.Platform()
	}
	lib := nodepath.Lib(platform)
	dir := NpmPrefixBinDir(UserPrefix(), platform)
	names := []string{kind}
	if platform == "win32" {
		names = []string{kind + ".cmd", kind + ".exe", kind}
	}
	for _, n := range names {
		if p := lib.Join(dir, n); usage.ExistsSync(p) {
			return p
		}
	}
	return ""
}

// Environment = environment()：PATH 上的 Node.js 与 npm，以及每个 CLI 要求的最低 Node 主版本与是否满足
func (s *CliUpdateService) Environment() *util.Obj {
	nodeV, nodeBin, npm := s.probe.NodeVersion(), s.probe.NodeBin(), s.probe.NpmBin()
	major := util.ToNumber("x")
	if nodeV != "" {
		major = util.ToNumber(strings.Split(nodeV, ".")[0])
	}
	reqs := []any{}
	for _, k := range []string{"claude", "codex", "dsh", "grok", "gemini"} {
		need := CliMinNodeMajor[k]
		reqs = append(reqs, util.NewObj("kind", k, "minNode", float64(need), "ok", isFinite(major) && major >= float64(need)))
	}
	return util.NewObj("nodeVersion", nz(nodeV), "nodePath", nz(nodeBin), "npmPath", nz(npm), "requirements", reqs)
}

func (s *CliUpdateService) load() {
	b, err := os.ReadFile(s.cachePath)
	if err != nil {
		s.cache = emptyCuCache()
		return
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		s.cache = emptyCuCache()
		return
	}
	s.cache = v
}

func (s *CliUpdateService) save() error {
	return os.WriteFile(s.cachePath, []byte(util.StringifyIndent(s.cache, "  ")), 0o666)
}

var errCuTypeError = errors.New("TypeError: Cannot use 'in' operator")

// jsGet = obj[key]（undefined → nil, false；null/undefined 上取属性 = TypeError）。
func jsGet(v any, key string) (any, bool, error) {
	switch o := v.(type) {
	case *util.Obj:
		if !o.Has(key) {
			return nil, false, nil
		}
		return o.Get(key), true, nil
	case nil:
		return nil, false, errCuTypeError
	}
	return nil, false, nil
}

// cacheLatest = this.cache.latest，以及 `k in latest` 是否可用（非对象抛 TypeError）。
func (s *CliUpdateService) cacheLatest() (*util.Obj, error) {
	l, _, err := jsGet(s.cache, "latest")
	if err != nil {
		return nil, err
	}
	switch o := l.(type) {
	case *util.Obj:
		return o, nil
	case []any:
		return util.NewObj(), nil
	}
	return nil, errCuTypeError
}

// cuNumber = Number(v)。
func cuNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	case string:
		return util.ToNumber(x)
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return cuNumber(x[0])
		}
	}
	return util.ToNumber("x")
}

func nz(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// refreshLatest：并发调用共用一次。
func (s *CliUpdateService) refreshLatest() *jsrt.Promise[struct{}] {
	if s.latestRefresh != nil {
		return s.latestRefresh
	}
	p := jsrt.Async(func() (struct{}, error) {
		vals := make([]*jsrt.Promise[string], len(latestKinds))
		for i, k := range latestKinds {
			pkg := NpmPkg[k]
			pr := jsrt.NewPromise[string]()
			go func() { pr.Resolve(FetchNpmLatest(pkg, 0)) }()
			vals[i] = pr
		}
		got := make([]string, len(vals))
		for i, pr := range vals {
			got[i], _ = jsrt.Await(pr)
		}
		old, err := s.cacheLatest()
		if err != nil {
			// old.claude 在 latest 为 null/undefined 时抛错（JS: Cannot read properties）
			if l, _, _ := jsGet(s.cache, "latest"); l == nil {
				return struct{}{}, err
			}
			old = util.NewObj()
		}
		latest := util.NewObj()
		for i, k := range latestKinds {
			if got[i] != "" {
				latest.Set(k, got[i])
			} else if v := old.Get(k); v != nil {
				latest.Set(k, v)
			} else {
				latest.Set(k, nil)
			}
		}
		latest.Set("cursor", nil)
		s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)
		_ = s.save() // cache 写失败不影响探测结果
		return struct{}{}, nil
	})
	out := jsrt.Async(func() (struct{}, error) {
		if _, err := jsrt.Await(p); err != nil && s.d.Logger != nil {
			s.d.Logger.Warn("cli-update latest check failed", err)
		}
		s.latestRefresh = nil
		return struct{}{}, nil
	})
	if !out.Settled() {
		s.latestRefresh = out
	}
	return out
}

// probeLocal：每个 CLI 起一个进程（并发）。
func (s *CliUpdateService) probeLocal() *jsrt.Promise[[]localProbe] {
	ps := make([]*jsrt.Promise[localProbe], len(inspectKinds))
	for i, kind := range inspectKinds {
		ps[i] = jsrt.Async(func() (localProbe, error) {
			bin := ResolveCliBinAsync(kind)
			version := ""
			if bin != "" {
				version = ReadVersionAsync(bin)
			}
			var warn *DshProblem
			if kind == "dsh" && bin != "" && !jsScriptRe.MatchString(bin) {
				warn = DshRuntimeProblemAsync()
			}
			return localProbe{kind: kind, bin: bin, version: version, runtimeWarning: warn}, nil
		})
	}
	return jsrt.Async(func() ([]localProbe, error) {
		out := make([]localProbe, len(ps))
		for i, p := range ps {
			v, err := jsrt.Await(p)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	})
}

var jsScriptRe = regexp.MustCompile(`\.(mjs|js)$`)

func dshProblemObj(p *DshProblem) any {
	if p == nil {
		return nil
	}
	var nv any
	if p.NodeVersion != nil {
		nv = *p.NodeVersion
	}
	return util.NewObj("nodeVersion", nv, "required", float64(p.Required))
}

// Inspect = inspect(refreshLatest)：已装版本 + 最新版本。
func (s *CliUpdateService) Inspect(refresh bool) *jsrt.Promise[[]*util.Obj] {
	return jsrt.Async(func() ([]*util.Obj, error) {
		rows, err := s.inspectInner(refresh)
		if err == nil {
			return rows, nil
		}
		if s.d.Logger != nil {
			s.d.Logger.Warn("cli-update inspect failed", err)
		}
		out := make([]*util.Obj, 0, len(inspectKinds))
		for _, kind := range inspectKinds {
			out = append(out, util.NewObj("kind", kind, "path", nil, "version", nil, "latest", nil,
				"installMethod", "unknown", "updateAvailable", false,
				"updateSupported", IsUpdatable(kind), "installSupported", IsUpdatable(kind)))
		}
		return out, nil
	})
}

func (s *CliUpdateService) inspectInner(refresh bool) ([]*util.Obj, error) {
	latest, err := s.cacheLatest()
	if err != nil {
		return nil, err
	}
	missing := false
	for _, k := range latestKinds {
		if !latest.Has(k) {
			missing = true
			break
		}
	}
	var latestTask *jsrt.Promise[struct{}]
	if refresh || missing {
		latestTask = s.refreshLatest()
	} else {
		checked, _, _ := jsGet(s.cache, "checkedAt")
		if cuNow()-cuNumber(checked) > latestTTLMs {
			s.refreshLatest()
		}
	}
	probed := s.probed
	if refresh || probed == nil || cuNow()-probed.at > probeTTLMs {
		entry := &probedEntry{at: cuNow(), rows: s.probeLocal()}
		probed = entry
		s.probed = entry
	}
	local, err := jsrt.Await(probed.rows)
	if err != nil {
		if s.probed == probed {
			s.probed = nil
		}
		return nil, err
	}
	if latestTask != nil {
		_, _ = jsrt.Await(latestTask)
	}
	out := make([]*util.Obj, 0, len(local))
	for _, r := range local {
		lt, err := s.cacheLatest()
		if err != nil {
			return nil, err
		}
		var lv any
		if v := lt.Get(r.kind); v != nil {
			lv = v
		}
		method := GuessInstallMethod(r.bin)
		if r.kind == "dsh" && r.bin != "" {
			method = "npm"
		}
		sup := IsUpdatable(r.kind)
		ls, _ := lv.(string)
		avail := sup && r.version != "" && ls != "" && IsNewer(ls, r.version)
		out = append(out, util.NewObj("kind", r.kind, "runtimeWarning", dshProblemObj(r.runtimeWarning),
			"path", nz(r.bin), "version", nz(r.version), "latest", lv, "installMethod", method,
			"updateAvailable", avail, "updateSupported", sup, "installSupported", sup))
	}
	return out, nil
}

type cuChecks struct {
	requirements   []any
	blockers       []string
	needsUserScope bool
}

func (s *CliUpdateService) checkRequirements(kind, scope string) cuChecks {
	var c cuChecks
	c.requirements = []any{}
	need := CliMinNodeMajor[kind]
	nodeV := s.probe.NodeVersion()
	major := util.ToNumber("x")
	if nodeV != "" {
		major = util.ToNumber(strings.Split(nodeV, ".")[0])
	}
	nodeOk := isFinite(major) && major >= float64(need)
	detail := i18n.T("electron.common.not-found")
	if nodeV != "" {
		detail = "v" + nodeV
	}
	c.requirements = append(c.requirements, util.NewObj("id", "node", "ok", nodeOk, "label", i18n.T("Node.js ≥ {0}", need), "detail", detail))
	if !nodeOk {
		if nodeV != "" {
			c.blockers = append(c.blockers, i18n.T("electron.common.node-js-is-required-found-v-please-upgrade", need, nodeV))
		} else {
			c.blockers = append(c.blockers, i18n.T("electron.common.node-js-was-not-found-please-install-node", need))
		}
	}
	npm := s.probe.NpmBin()
	nd := npm
	if npm == "" {
		nd = i18n.T("electron.common.not-found")
	}
	c.requirements = append(c.requirements, util.NewObj("id", "npm", "ok", npm != "", "label", "npm", "detail", nd))
	if npm == "" {
		c.blockers = append(c.blockers, i18n.T("electron.common.npm-was-not-found-it-ships-with-node"))
	}
	target := ""
	if scope == "user" {
		target = UserPrefix()
	} else if pf := s.probe.NpmPrefix(); pf != "" {
		target = pf
	} else if npm == "" {
		target = UserPrefix()
	}
	if npm != "" && target != "" {
		writable := s.probe.CanWrite(target)
		c.requirements = append(c.requirements, util.NewObj("id", "write", "ok", writable, "label", i18n.T("electron.common.directory-writable"), "detail", target))
		if !writable {
			if scope == "global" {
				c.needsUserScope = true
				c.blockers = append(c.blockers, i18n.T("electron.common.the-npm-global-directory-is-not-writable-nomi", target))
			} else {
				c.blockers = append(c.blockers, i18n.T("electron.common.the-user-directory-is-not-writable", target))
			}
		}
	}
	return c
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func cuStrs(ss []string) []any {
	out := make([]any, len(ss))
	for i, v := range ss {
		out[i] = v
	}
	return out
}

type cuPlanned struct {
	plan    *util.Obj
	argv    []string
	command string
	mode    string
	blocks  []string
	recipes []UpdateRecipe
}

func (s *CliUpdateService) plan(kind, scope string) cuPlanned {
	bin := ResolveCliBinAsync(kind)
	mode := "install"
	if bin != "" {
		mode = "update"
	}
	method := GuessInstallMethod(bin)
	if kind == "dsh" && bin != "" {
		method = "npm"
	}
	recipes := UpdateRecipes(kind, bin, method, scope)
	first := recipes[0]
	checks := cuChecks{requirements: []any{}}
	if first.Via == "npm" {
		checks = s.checkRequirements(kind, scope)
	}
	blockers := append([]string{}, checks.blockers...)
	if !IsAllowedUpdateArgv(first.Argv) {
		blockers = append([]string{i18n.T("electron.common.the-command-is-not-on-the-allow-list")}, blockers...)
	}
	cmd := CommandLine(first.Argv)
	plan := util.NewObj("kind", kind, "mode", mode, "scope", scope, "argv", cuStrs(first.Argv),
		"command", cmd, "requirements", checks.requirements, "blockers", cuStrs(blockers))
	if checks.needsUserScope {
		plan.Set("userScopeCommand", CommandLine(UpdateRecipes(kind, bin, "npm", "user")[0].Argv))
	}
	return cuPlanned{plan: plan, argv: first.Argv, command: cmd, mode: mode, blocks: blockers, recipes: recipes}
}

// PreviewUpdate = previewUpdate(kind, scope)。
func (s *CliUpdateService) PreviewUpdate(kind, scope string) *jsrt.Promise[*util.Obj] {
	if scope == "" {
		scope = "global"
	}
	return jsrt.Async(func() (*util.Obj, error) { return s.plan(kind, scope).plan, nil })
}

func (j *cliJob) snapshot() *util.Obj {
	o := util.NewObj("kind", j.kind, "mode", j.mode, "scope", j.scope, "status", j.status,
		"argv", cuStrs(j.argv), "command", j.command, "lines", cuStrs(j.lines), "startedAt", j.startedAt)
	if j.finished {
		o.Set("result", j.result.Clone())
		o.Set("finishedAt", j.finishedAt)
	}
	return o
}

// Job = job(kind)（nil = null）。
func (s *CliUpdateService) Job(kind string) *util.Obj {
	j := s.jobs[kind]
	if j == nil {
		return nil
	}
	return j.snapshot()
}

// DismissJob = dismissJob(kind)。
func (s *CliUpdateService) DismissJob(kind string) bool {
	j := s.jobs[kind]
	if j == nil || j.status == "running" {
		return false
	}
	delete(s.jobs, kind)
	return true
}

func cuResult(ok bool, log, version string) *util.Obj {
	return util.NewObj("ok", ok, "log", log, "version", nz(version))
}

func (s *CliUpdateService) finishJob(kind string, r *util.Obj) {
	s.probed = nil
	j := s.jobs[kind]
	if j == nil || j.status != "running" {
		return
	}
	ok, _ := r.Get("ok").(bool)
	if ok {
		j.status = "done"
	} else {
		j.status = "error"
	}
	j.result = r
	j.finishedAt = cuNow()
	j.finished = true
	if ok && s.d.OnUpdated != nil {
		v, _ := r.Get("version").(string)
		func() {
			defer func() {
				if e := recover(); e != nil && s.d.Logger != nil {
					s.d.Logger.Warn("cli onUpdated hook failed", util.NewObj("kind", kind, "error", fmt.Sprint(e)))
				}
			}()
			s.d.OnUpdated(kind, v)
		}()
	}
}

// Run = run(kind, scope)：同一端点重复调用复用当前任务。
func (s *CliUpdateService) Run(kind, scope string) *jsrt.Promise[*util.Obj] {
	if scope == "" {
		scope = "global"
	}
	if cur := s.inflight[kind]; cur != nil {
		return cur
	}
	s.jobs[kind] = &cliJob{kind: kind, mode: "update", scope: scope, status: "running", argv: []string{}, lines: []string{}, startedAt: cuNow()}
	inner := jsrt.Async(func() (*util.Obj, error) { return s.runJob(kind, scope), nil })
	p := jsrt.Async(func() (*util.Obj, error) {
		r, _ := jsrt.Await(inner)
		s.finishJob(kind, r)
		delete(s.inflight, kind)
		for i, k := range s.inflightOrder {
			if k == kind {
				s.inflightOrder = append(s.inflightOrder[:i:i], s.inflightOrder[i+1:]...)
				break
			}
		}
		return r, nil
	})
	if !p.Settled() {
		s.inflight[kind] = p
		s.inflightOrder = append(s.inflightOrder, kind)
	}
	return p
}

// RunUpdate = runUpdate（兼容旧名）。
func (s *CliUpdateService) RunUpdate(kind, scope string) *jsrt.Promise[*util.Obj] {
	return s.Run(kind, scope)
}

// BusyKinds = busyKinds()。
func (s *CliUpdateService) BusyKinds() []string { return append([]string{}, s.inflightOrder...) }

func (s *CliUpdateService) inNpmQueue(scope string, onWait func(), fn func() (CliRunOutput, error)) (CliRunOutput, error) {
	prev := s.npmQueue[scope]
	mine := jsrt.NewPromise[struct{}]()
	tail := jsrt.Async(func() (struct{}, error) {
		if prev != nil {
			_, _ = jsrt.Await(prev)
		}
		return jsrt.Await(mine)
	})
	s.npmQueue[scope] = tail
	if prev != nil {
		onWait()
		_, _ = jsrt.Await(prev)
	}
	defer func() {
		mine.Resolve(struct{}{})
		if s.npmQueue[scope] == tail {
			delete(s.npmQueue, scope)
		}
	}()
	return fn()
}

func (s *CliUpdateService) runJob(kind, scope string) *util.Obj {
	planned := s.plan(kind, scope)
	if len(planned.blocks) > 0 {
		return cuResult(false, strings.Join(planned.blocks, "\n"), "")
	}
	platform := s.d.Platform
	if platform == "" {
		platform = usage.Platform()
	}
	if platform == "win32" && s.d.Drain != nil {
		busy, err := jsrt.Await(s.d.Drain(kind))
		if err != nil {
			busy = 0
		}
		if busy > 0 {
			return cuResult(false, i18n.T("electron.common.session-s-are-still-using-this-cli-windows", busy), "")
		}
	}
	mode := planned.mode
	if j := s.jobs[kind]; j != nil {
		j.mode = mode
		j.argv = planned.argv
		j.command = planned.command
	}
	s.broadcast(util.NewObj("kind", kind, "mode", mode, "phase", "start", "argv", cuStrs(planned.argv)))
	logLine := func(l string) { s.broadcast(util.NewObj("kind", kind, "mode", mode, "phase", "log", "line", l)) }
	var logs []string
	ok := false
	recipes := planned.recipes
	for i, recipe := range recipes {
		if recipe.Via == "npm" && i != 0 {
			again := s.checkRequirements(kind, scope)
			if len(again.blockers) > 0 {
				logs = append(logs, again.blockers...)
				break
			}
		}
		if !IsAllowedUpdateArgv(recipe.Argv) {
			logs = append(logs, i18n.T("electron.common.rejected-command-not-on-whitelist"))
			continue
		}
		line := "$ " + CommandLine(recipe.Argv)
		logs = append(logs, line)
		logLine(line)
		argv := recipe.Argv
		exec := func() (CliRunOutput, error) { return jsrt.Await(s.runner(argv, logLine, 10*60_000)) }
		var res CliRunOutput
		var err error
		if recipe.Via == "npm" {
			res, err = s.inNpmQueue(scope, func() { logLine(i18n.T("electron.common.waiting-for-another-npm-install-to-finish")) }, exec)
		} else {
			res, err = exec()
		}
		if err != nil {
			msg := err.Error()
			s.finishJob(kind, cuResult(false, msg, ""))
			s.broadcast(util.NewObj("kind", kind, "mode", mode, "phase", "error", "message", msg))
			return cuResult(false, msg, "")
		}
		if res.Output != "" {
			logs = append(logs, res.Output)
		}
		if res.Code != nil && *res.Code == 0 {
			ok = true
			break
		}
		var code any = "—"
		if res.Code != nil {
			code = float64(*res.Code)
		}
		logs = append(logs, i18n.T("electron.common.command-failed-exit-code", code))
	}
	log := util.UTF16Tail(strings.Join(logs, "\n"), 8000)
	bin := ResolveCliBinAsync(kind)
	npmBinDir := ""
	if bin == "" && ok {
		prefix := ""
		if scope == "user" {
			prefix = UserPrefix()
		} else {
			prefix = s.probe.NpmPrefix()
		}
		if prefix != "" {
			npmBinDir = NpmPrefixBinDir(prefix, "")
			RememberCliDir(npmBinDir)
			bin = ResolveCliBinAsync(kind)
		}
	}
	// 用户目录安装：PATH 上可能还有更早的旧版本挡在前面，记下装好的这一份，之后探测与启动都优先用它；
	// 改用全局安装就回到按 PATH 找
	if ok {
		own := ""
		if scope == "user" {
			own = s.userBin(kind)
		}
		s.setPreferred(kind, own)
		if own != "" {
			bin = own
		}
	}
	version := ""
	if bin != "" {
		version = ReadVersionAsync(bin)
	}
	if !ok {
		s.finishJob(kind, cuResult(false, log, version))
		s.broadcast(util.NewObj("kind", kind, "mode", mode, "phase", "error", "message", log))
		return cuResult(false, log, version)
	}
	note := ""
	hasNote := false
	if bin == "" {
		hasNote = true
		if npmBinDir != "" {
			note = i18n.T("electron.common.the-command-finished-but-wasn-t-found-in", kind, npmBinDir)
		} else {
			note = i18n.T("electron.common.the-command-finished-but-was-not-found-on", kind)
		}
	} else if scope == "user" {
		lib := nodepath.Lib(usage.Platform())
		dir := lib.Dirname(bin)
		inPath := false
		for _, p := range strings.Split(os.Getenv("PATH"), string(os.PathListSeparator)) {
			if p == dir {
				inPath = true
				break
			}
		}
		if !inPath {
			hasNote = true
			note = i18n.T("electron.common.installed-to-to-use-it-from-a-terminal", dir)
		}
	}
	result := util.NewObj("ok", bin != "", "log", log, "version", nz(version), "path", nz(bin))
	if hasNote {
		result.Set("note", note)
	}
	s.finishJob(kind, result)
	s.broadcast(util.NewObj("kind", kind, "mode", mode, "phase", "done", "version", nz(version)))
	return result
}

func (s *CliUpdateService) broadcast(payload *util.Obj) {
	kind, _ := payload.Get("kind").(string)
	if j := s.jobs[kind]; j != nil && j.status == "running" && payload.Get("phase") == "log" {
		if l, ok := payload.Get("line").(string); ok {
			j.lines = append(j.lines, l)
			if len(j.lines) > 400 {
				j.lines = append([]string{}, j.lines[len(j.lines)-400:]...)
			}
		}
	}
	if s.d.Emit != nil {
		s.d.Emit(payload)
	}
	if s.d.Events != nil {
		s.d.Events.Publish("cliUpdate.event", payload)
	}
}
