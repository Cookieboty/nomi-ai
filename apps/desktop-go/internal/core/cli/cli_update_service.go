// cli_update_service.go：CliUpdateService（CLI 版本检测、安装与白名单更新）。
//
// 安装 / 更新只执行固定 argv 的白名单命令；Windows 的 npm.cmd 例外地经 shell 执行，参数同样来自白名单。
// 除 Inspect / 本机探测在普通 goroutine 里跑（不占 GIL）外，其余方法持 jsrt 锁调用；耗时操作返回 Promise。
package cli

import (
	"errors"
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
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

func scriptForPlatform(kind, platform string) string {
	if platform == "" {
		platform = usage.Platform()
	}
	if platform == "win32" {
		return builtin.WindowsInstallScript(kind)
	}
	return builtin.InstallScript(kind)
}

func scriptArgvForPlatform(kind, platform string) ([]string, string) {
	if platform == "" {
		platform = usage.Platform()
	}
	sc := scriptForPlatform(kind, platform)
	if sc == "" {
		return nil, ""
	}
	if platform == "win32" {
		return []string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference = 'Stop'; " + sc}, sc
	}
	return []string{"bash", "-o", "pipefail", "-c", sc}, sc
}

// UpdateRecipes = updateRecipes(kind, bin, method, scope)；bin "" = null，scope "" = global。
func UpdateRecipes(kind, bin, method, scope string) []UpdateRecipe {
	return UpdateRecipesForPlatform(kind, bin, method, scope, usage.Platform())
}

// UpdateRecipesForPlatform 按指定平台生成安装/更新配方（self → npm → 官方安装脚本）。
func UpdateRecipesForPlatform(kind, bin, method, scope, platform string) []UpdateRecipe {
	if scope == "" {
		scope = "global"
	}
	if platform == "" {
		platform = usage.Platform()
	}
	var recipes []UpdateRecipe
	su := builtin.SelfUpdate(kind)
	if bin != "" && (su == "always" || su == "native" && (method == "native" || method == "unknown")) {
		recipes = append(recipes, UpdateRecipe{Kind: kind, Via: "self", Argv: []string{bin, "update"}})
	}
	if pkg := NpmPkg[kind]; pkg != "" {
		argv := []string{npmCommand(), "install", "-g", pkg + "@latest"}
		if scope == "user" {
			argv = append(argv, "--prefix", UserPrefix())
		}
		recipes = append(recipes, UpdateRecipe{Kind: kind, Via: "npm", Argv: argv})
	} else if argv, _ := scriptArgvForPlatform(kind, platform); len(argv) > 0 {
		recipes = append(recipes, UpdateRecipe{Kind: kind, Via: "script", Argv: argv})
	}
	return recipes
}

var cmdSuffixRe = regexp.MustCompile(`(?i)\.cmd$`)

// allowedPkgs：只许更新内置 CLI 的 npm 包
var allowedPkgs = func() map[string]bool {
	m := map[string]bool{}
	for _, id := range builtin.Ordered {
		if p := builtin.NpmPackage(id); p != "" {
			m[p+"@latest"] = true
		}
	}
	return m
}()

// allowedPosixScripts / allowedWinScripts：只许执行内置 CLI 清单登记的官方安装脚本
var allowedPosixScripts = func() map[string]bool {
	m := map[string]bool{}
	for _, id := range builtin.Ordered {
		if sc := builtin.InstallScript(id); sc != "" {
			m[sc] = true
		}
	}
	return m
}()

var allowedWinScripts = func() map[string]bool {
	m := map[string]bool{}
	for _, id := range builtin.Ordered {
		if ws := builtin.WindowsInstallScript(id); ws != "" {
			m["$ErrorActionPreference = 'Stop'; "+ws] = true
		}
	}
	return m
}()

// selfUpdating：能 `<bin> update` 自己更新的命令名
func selfUpdating(cmd, base string) bool {
	for _, id := range builtin.Ordered {
		if builtin.SelfUpdate(id) == "" {
			continue
		}
		for _, b := range builtin.Binaries(id) {
			if base == b || strings.HasSuffix(cmd, b) {
				return true
			}
		}
	}
	return false
}

// IsAllowedUpdateArgv = isAllowedUpdateArgv。
func IsAllowedUpdateArgv(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	cmd, rest := argv[0], argv[1:]
	base := util.JSLower(cmdSuffixRe.ReplaceAllString(nodepath.Lib(usage.Platform()).Basename(cmd), ""))
	if selfUpdating(cmd, base) && len(rest) == 1 && rest[0] == "update" {
		return true
	}
	if base == "bash" && len(rest) == 4 && rest[0] == "-o" && rest[1] == "pipefail" && rest[2] == "-c" && allowedPosixScripts[rest[3]] {
		return true
	}
	if (base == "powershell" || base == "powershell.exe") && len(rest) == 5 && rest[0] == "-NoProfile" && rest[1] == "-ExecutionPolicy" && rest[2] == "Bypass" && rest[3] == "-Command" && allowedWinScripts[rest[4]] {
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
	return builtin.IsBuiltinCliID(kind)
}

// ToUpdatable = toUpdatable。
func ToUpdatable(kind any) string {
	if s, ok := kind.(string); ok && builtin.IsBuiltinCliID(s) {
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

// CliToolProbe：可选探针扩展，用于检查官方安装脚本所需的系统工具（bash / curl / powershell.exe）。
type CliToolProbe interface {
	FindTool(name string) string
}

type defaultCliProbe struct{}

// DefaultCliProbe = defaultProbe。
var DefaultCliProbe CliProbe = defaultCliProbe{}

func (defaultCliProbe) NodeVersion() string { return ReadPathNodeVersionAsync() }
func (defaultCliProbe) NodeBin() string     { return ResolveNodeBin() }
func (defaultCliProbe) NpmBin() string      { return ResolveNpmBinAsync() }
func (defaultCliProbe) FindTool(name string) string {
	return FindOnPath(name, WithCliPath(nil), usage.Platform(), nil)
}
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
		child = nodeproc.Spawn(f, a, nodeproc.Options{Env: env, Verbatim: verbatim, IgnoreStdin: true})
	} else {
		child = nodeproc.Spawn(argv[0], argv[1:], nodeproc.Options{Env: env, IgnoreStdin: true})
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

var inspectKinds = append(slices.Clone(builtin.Ordered), "cursor")
var latestKinds = builtin.Ordered

const (
	probeTTLMs  = 5 * 60_000
	latestTTLMs = 6 * 60 * 60_000
	// inspectTimeout：整次 inspect 的上限。只覆盖本地探测（登录 shell PATH 最多 4.5s，
	// --version 8s + SIGKILL 宽限 3s），再留一点余量；首次展示不再等 npm view（12s）。
	// 探测卡在无超时的路径（挂死的网络盘、Kill 后 Wait 不返回）时，到点也要把结果交回 UI。
	defaultInspectTimeout = 20 * time.Second
)

// 下面三个可在测试里替换（避免真实找二进制 / 问 npm）。
// resolveInspectBin / readInspectVersion 在 probeLocal 里放到后台执行，钩子不能再调 jsrt.Await。
var (
	inspectTimeout     = defaultInspectTimeout
	fetchNpmLatest     = FetchNpmLatest
	resolveInspectBin  = inspectResolveBin
	readInspectVersion = ReadVersion
)

func inspectResolveBin(kind string) string {
	return cacheBin(kind, ResolveCliBin(kind))
}

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
	at       float64
	rows     *jsrt.Promise[[]localProbe]
	followed bool
}

// CliUpdateService = CliUpdateService。
type CliUpdateService struct {
	// Freeze test hooks at construction: background work can outlive an inspect
	// timeout or a test cleanup, and must never read replaced package variables.
	inspectLimit    time.Duration
	fetchLatest     func(string, int) string
	resolveBin      func(string) string
	readVersion     func(string) string
	d               CliUpdateOptions
	cache           any // JSON.parse 的结果（不校验形状）
	probed          *probedEntry
	latestRefresh   *jsrt.Promise[struct{}]
	lastLocal       []localProbe
	lastRows        []*util.Obj
	lastRowsSnap    atomic.Value // []*util.Obj；超时回调不持 GIL 也能读到上次结果
	inspectTimedOut atomic.Bool
	mu              sync.Mutex // cache / probed / lastLocal / lastRows / latestRefresh（Inspect 不占 GIL）
	cachePath       string
	preferredPath   string // 用户目录安装成功的 CLI → 可执行文件（重启后仍优先用它，见 PreferCliBin）
	preferred       map[string]string
	jobs            map[string]*cliJob
	inflight        map[string]*jsrt.Promise[*util.Obj]
	inflightOrder   []string
	npmQueue        map[string]*jsrt.Promise[struct{}]
	probe           CliProbe
	runner          CliRunner
}

// cuNow = Date.now()（测试可替换）。
var cuNow = func() float64 { return float64(time.Now().UnixMilli()) }

func emptyCuCache() *util.Obj { return util.NewObj("checkedAt", float64(0), "latest", util.NewObj()) }

func localInstalled(local []localProbe) (ok, miss int) {
	for _, r := range local {
		if r.bin != "" {
			ok++
		} else {
			miss++
		}
	}
	return
}

func (s *CliUpdateService) logInspect(warn bool, msg string, d any) {
	if s == nil || s.d.Logger == nil {
		return
	}
	if warn {
		s.d.Logger.Warn(msg, d)
	} else {
		s.d.Logger.Info(msg, d)
	}
}

// NewCliUpdateService = new CliUpdateService(d)。
func NewCliUpdateService(d CliUpdateOptions) (*CliUpdateService, error) {
	s := &CliUpdateService{d: d,
		inspectLimit: inspectTimeout, fetchLatest: fetchNpmLatest,
		resolveBin: resolveInspectBin, readVersion: readInspectVersion, jobs: map[string]*cliJob{}, inflight: map[string]*jsrt.Promise[*util.Obj]{}, npmQueue: map[string]*jsrt.Promise[struct{}]{}}
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
	for _, k := range builtin.Ordered {
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
	platform := s.effectivePlatform()
	lib := nodepath.Lib(platform)
	dir := NpmPrefixBinDir(UserPrefix(), platform)
	names := append([]string{}, builtin.Binaries(kind)...)
	if len(names) == 0 {
		names = []string{kind}
	}
	if platform == "win32" {
		winNames := make([]string, 0, len(names)*3)
		for _, n := range names {
			winNames = append(winNames, n+".cmd", n+".exe", n)
		}
		names = winNames
	}
	for _, n := range names {
		if p := lib.Join(dir, n); usage.ExistsSync(p) {
			return p
		}
	}
	return ""
}

func (s *CliUpdateService) effectivePlatform() string {
	if s.d.Platform != "" {
		return s.d.Platform
	}
	return usage.Platform()
}

func (s *CliUpdateService) findTool(name, platform string) string {
	if tp, ok := s.probe.(CliToolProbe); ok {
		return tp.FindTool(name)
	}
	return FindOnPath(name, WithCliPath(nil), platform, nil)
}

// Environment = environment()：PATH 上的 Node.js 与 npm，以及每个 CLI 要求的最低 Node 主版本与是否满足
func (s *CliUpdateService) Environment() *util.Obj {
	nodeV, nodeBin, npm := s.probe.NodeVersion(), s.probe.NodeBin(), s.probe.NpmBin()
	major := util.ToNumber("x")
	if nodeV != "" {
		major = util.ToNumber(strings.Split(nodeV, ".")[0])
	}
	reqs := []any{}
	for _, k := range builtin.Ordered {
		need := CliMinNodeMajor[k]
		if need <= 0 {
			continue
		}
		reqs = append(reqs, util.NewObj("kind", k, "minNode", float64(need), "ok", isFinite(major) && major >= float64(need)))
	}
	return util.NewObj("nodeVersion", nz(nodeV), "nodePath", nz(nodeBin), "npmPath", nz(npm), "requirements", reqs)
}

func (s *CliUpdateService) load() {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}

func (s *CliUpdateService) saveLocked() error {
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
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	if s.latestRefresh != nil {
		cur := s.latestRefresh
		s.mu.Unlock()
		// TEMP(cli-inspect): 定位用，后续可随时移除
		s.logInspect(false, "cli-update latest refresh", "reuse in-flight")
		return cur
	}
	s.mu.Unlock()
	// TEMP(cli-inspect): 定位用，后续可随时移除
	s.logInspect(false, "cli-update latest refresh start", nil)
	p := jsrt.Async(func() (struct{}, error) {
		vals := make([]*jsrt.Promise[string], len(latestKinds))
		for i, k := range latestKinds {
			pkg := NpmPkg[k]
			pr := jsrt.NewPromise[string]()
			if pkg == "" {
				pr.Resolve("")
			} else {
				go func() { pr.Resolve(s.fetchLatest(pkg, 0)) }()
			}
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
		s.mu.Lock()
		s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)
		_ = s.saveLocked() // cache 写失败不影响探测结果
		s.mu.Unlock()
		return struct{}{}, nil
	})
	started := time.Now()
	out := jsrt.Async(func() (struct{}, error) {
		_, err := jsrt.Await(p)
		if err != nil {
			// TEMP(cli-inspect): 定位用，后续可随时移除
			s.logInspect(true, "cli-update latest check failed", err)
		}
		// TEMP(cli-inspect): 定位用，后续可随时移除
		s.logInspect(false, "cli-update latest refresh", time.Since(started).Round(time.Millisecond).String())
		s.mu.Lock()
		s.latestRefresh = nil
		local := s.lastLocal
		s.mu.Unlock()
		// 首次 inspect 已把本地结果交出去；latest 写进缓存后再推一次，界面补上「最新版本」。
		if local != nil {
			if rows, berr := s.rowsFromLocal(local); berr == nil {
				// TEMP(cli-inspect): 定位用，后续可随时移除
				s.logInspect(false, "cli-update inspect event", "kind=inspect phase=updated")
				s.emitInspectUpdated(rows)
			} else {
				// TEMP(cli-inspect): 定位用，后续可随时移除
				s.logInspect(true, "cli-update inspect event skipped", berr)
			}
		}
		return struct{}{}, nil
	})
	if !out.Settled() {
		s.mu.Lock()
		s.latestRefresh = out
		s.mu.Unlock()
	}
	return out
}

// probeLocal：每个 CLI 起一个进程（并发）。
// 整段探测不占 GIL：等 login shell PATH、找二进制、--version 都在普通 goroutine 里跑，
// 这样启动阶段即使有人占着 jsrt 锁，inspect 也能在超时前返回。
func (s *CliUpdateService) probeLocal() *jsrt.Promise[[]localProbe] {
	p := jsrt.NewPromise[[]localProbe]()
	go func() {
		// TEMP(cli-inspect): 定位用，后续可随时移除
		s.logInspect(false, "cli-update probe path-wait start", nil)
		pathWaitStarted := time.Now()
		WaitForShellPathOffThread(0)
		// TEMP(cli-inspect): 定位用，后续可随时移除
		s.logInspect(false, "cli-update probe path-wait done", time.Since(pathWaitStarted).Round(time.Millisecond).String())
		out := make([]localProbe, len(inspectKinds))
		var wg sync.WaitGroup
		wg.Add(len(inspectKinds))
		for i, kind := range inspectKinds {
			i, kind := i, kind
			go func() {
				defer wg.Done()
				resolveStarted := time.Now()
				bin := s.resolveBin(kind)
				resolveMs := time.Since(resolveStarted)
				version := ""
				var versionMs time.Duration
				if bin != "" {
					versionStarted := time.Now()
					version = s.readVersion(bin)
					versionMs = time.Since(versionStarted)
				}
				var warn *DshProblem
				if kind == "dsh" && bin != "" && !jsScriptRe.MatchString(bin) {
					if v := ReadPathNodeVersion(); v != "" {
						warn = DshRuntimeProblem(&v)
					} else {
						warn = DshRuntimeProblem(nil)
					}
				}
				pathLabel := "missing"
				if bin != "" {
					pathLabel = bin
				}
				detail := fmt.Sprintf("kind=%s installed=%v path=%s resolve=%s", kind, bin != "", pathLabel, resolveMs.Round(time.Millisecond))
				if bin != "" {
					if version != "" {
						detail += fmt.Sprintf(" version=%s versionMs=%s", version, versionMs.Round(time.Millisecond))
					} else {
						detail += fmt.Sprintf(" version-error=unreadable versionMs=%s", versionMs.Round(time.Millisecond))
					}
				}
				// TEMP(cli-inspect): 定位用，后续可随时移除
				s.logInspect(false, "cli-update probe", detail)
				out[i] = localProbe{kind: kind, bin: bin, version: version, runtimeWarning: warn}
			}()
		}
		wg.Wait()
		p.Resolve(out)
	}()
	return p
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

// emptyInspectRows：探测失败 / 超时时的占位（全部视为未安装，避免 UI 一直停在「检测中」）。
func emptyInspectRows() []*util.Obj {
	out := make([]*util.Obj, 0, len(inspectKinds))
	platform := usage.Platform()
	for _, kind := range inspectKinds {
		hasNpm := NpmPkg[kind] != ""
		hasScript := scriptForPlatform(kind, platform) != ""
		installSup := IsUpdatable(kind) && (hasNpm || hasScript)
		out = append(out, util.NewObj("kind", kind, "path", nil, "version", nil, "latest", nil,
			"installMethod", "unknown", "updateAvailable", false,
			"updateSupported", installSup, "installSupported", installSup))
	}
	return out
}

func objsToAny(rows []*util.Obj) []any {
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = r
	}
	return out
}

func (s *CliUpdateService) rowsFromLocal(local []localProbe) ([]*util.Obj, error) {
	lt, err := s.cacheLatest()
	if err != nil {
		return nil, err
	}
	platform := s.effectivePlatform()
	out := make([]*util.Obj, 0, len(local))
	for _, r := range local {
		var lv any
		if v := lt.Get(r.kind); v != nil {
			lv = v
		}
		hasNpm := NpmPkg[r.kind] != ""
		hasScript := scriptForPlatform(r.kind, platform) != ""
		method := GuessInstallMethod(r.bin)
		if r.kind == "dsh" && r.bin != "" {
			method = "npm"
		} else if r.bin != "" && method == "unknown" && !hasNpm && hasScript {
			method = "native"
		}
		updatable := IsUpdatable(r.kind)
		installSup := updatable && (hasNpm || hasScript)
		sup := updatable && (hasNpm || hasScript || (r.bin != "" && builtin.SelfUpdate(r.kind) != ""))
		ls, _ := lv.(string)
		avail := sup && r.version != "" && ls != "" && IsNewer(ls, r.version)
		// 假 CLI（2.0.0-mock）比正式版号旧，但不能拿 npm 安装盖掉它
		if MockCliUpdate(r.bin, r.version) {
			sup = false
			installSup = false
			avail = false
			lv = nil
		}
		out = append(out, util.NewObj("kind", r.kind, "runtimeWarning", dshProblemObj(r.runtimeWarning),
			"path", nz(r.bin), "version", nz(r.version), "latest", lv, "installMethod", method,
			"updateAvailable", avail, "updateSupported", sup, "installSupported", installSup))
	}
	return out, nil
}

func (s *CliUpdateService) setLastRows(rows []*util.Obj) {
	s.mu.Lock()
	s.lastRows = rows
	s.mu.Unlock()
	if len(rows) > 0 {
		s.lastRowsSnap.Store(rows)
	}
}

func (s *CliUpdateService) emitInspectUpdated(rows []*util.Obj) {
	s.setLastRows(rows)
	s.broadcast(util.NewObj("kind", "inspect", "phase", "updated", "rows", objsToAny(rows)))
}

func (s *CliUpdateService) followProbe(entry *probedEntry) {
	if entry == nil {
		return
	}
	// 两次 inspect 可能同时跑在普通 goroutine 里，followed 也要在锁里改
	s.mu.Lock()
	if entry.followed {
		s.mu.Unlock()
		return
	}
	entry.followed = true
	s.mu.Unlock()
	go func() {
		local, err := jsrt.Block(entry.rows)
		if err != nil {
			s.mu.Lock()
			if s.probed == entry {
				s.probed = nil
			}
			s.mu.Unlock()
			// TEMP(cli-inspect): 定位用，后续可随时移除
			s.logInspect(true, "cli-update inspect follow failed", err)
			return
		}
		s.mu.Lock()
		s.lastLocal = local
		s.mu.Unlock()
		rows, berr := s.rowsFromLocal(local)
		if berr != nil {
			// TEMP(cli-inspect): 定位用，后续可随时移除
			s.logInspect(true, "cli-update inspect follow failed", berr)
			return
		}
		s.setLastRows(rows)
		if s.inspectTimedOut.Load() {
			ok, miss := localInstalled(local)
			// TEMP(cli-inspect): 定位用，后续可随时移除
			s.logInspect(false, "cli-update inspect late result", fmt.Sprintf("rows=%d installed=%d missing=%d", len(local), ok, miss))
			// 推事件要读 jobs、走事件总线，这些都按持 GIL 访问：回到 jsrt 线程再发。
			// 只是晚到的补推，等锁不影响 inspect 本身按时返回
			jsrt.Go(func() { s.emitInspectUpdated(rows) })
		}
	}()
}

func (s *CliUpdateService) inspectFallback() []*util.Obj {
	if v, ok := s.lastRowsSnap.Load().([]*util.Obj); ok && len(v) > 0 {
		return v
	}
	return emptyInspectRows()
}

// Inspect = inspect(refresh)：先返回本机探测（已安装 / 未安装、路径、版本）；
// 缓存里已有 latest 就带上。缓存是冷的或调用方要求刷新时，在后台问 npm，完成后发
// cliUpdate.event {kind:inspect, phase:updated}。整次调用有总超时，避免 UI 一直「检测中」。
func (s *CliUpdateService) Inspect(refresh bool) *jsrt.Promise[[]*util.Obj] {
	// 探测在普通 goroutine 里跑，返回的 Promise 也不再经 Await 回等 GIL。
	// 这样「inspect start 已打出、但 inspectInner 拿不到锁」的 20s 空超时不会再发生；
	// IPC 用 jsrt.Block 等结果即可，不必占着 jsrt 锁。
	// TEMP(cli-inspect): 定位用，后续可随时移除
	s.logInspect(false, "cli-update inspect start", fmt.Sprintf("refreshLatest=%v", refresh))
	s.inspectTimedOut.Store(false)
	outcome := jsrt.NewPromise[[]*util.Obj]()
	var done sync.Once
	// 用 Go timer，不依赖 jsrt 事件循环：先武装再开工。
	timer := time.AfterFunc(s.inspectLimit, func() {
		done.Do(func() {
			s.inspectTimedOut.Store(true)
			fallback := "empty"
			n := 0
			if v, ok := s.lastRowsSnap.Load().([]*util.Obj); ok && len(v) > 0 {
				fallback = "lastRows"
				n = len(v)
			}
			// TEMP(cli-inspect): 定位用，后续可随时移除
			s.logInspect(true, "cli-update inspect timed out", fmt.Sprintf("timeout=%s fallback=%s rows=%d", s.inspectLimit, fallback, n))
			outcome.Resolve(s.inspectFallback())
		})
	})
	go func() {
		rows, err := s.inspectInner(refresh)
		if !timer.Stop() {
			return
		}
		done.Do(func() {
			if err != nil {
				// TEMP(cli-inspect): 定位用，后续可随时移除
				s.logInspect(true, "cli-update inspect failed", err)
				outcome.Resolve(emptyInspectRows())
				return
			}
			outcome.Resolve(rows)
		})
	}()
	return outcome
}

func (s *CliUpdateService) inspectInner(refresh bool) ([]*util.Obj, error) {
	started := time.Now()
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
	s.mu.Lock()
	checked, _, _ := jsGet(s.cache, "checkedAt")
	stale := cuNow()-cuNumber(checked) > latestTTLMs
	cacheState := "warm"
	if missing {
		cacheState = "cold"
	} else if stale {
		cacheState = "stale"
	}
	willRefresh := refresh || missing || stale
	// 计划与使用必须基于同一份快照；finishJob 可能在解锁后清空缓存。
	probed := s.probed
	willProbe := refresh || probed == nil || cuNow()-probed.at > probeTTLMs
	s.mu.Unlock()
	// TEMP(cli-inspect): 定位用，后续可随时移除
	s.logInspect(false, "cli-update inspect plan", fmt.Sprintf("refreshLatest=%v cache=%s willRefresh=%v willProbe=%v", refresh, cacheState, willRefresh, willProbe))
	// 冷缓存、过期或用户点「检查更新」：后台刷新 latest，不堵住本次返回。
	// refreshLatest 仍要进 jsrt（写 cache）；探测本身不再等这把锁。
	if willRefresh {
		jsrt.Go(func() { s.refreshLatest() })
	}
	if willProbe {
		entry := &probedEntry{at: cuNow(), rows: s.probeLocal()}
		s.mu.Lock()
		probed = entry
		s.probed = entry
		s.mu.Unlock()
	}
	s.followProbe(probed)
	probeStarted := time.Now()
	local, err := jsrt.Block(probed.rows)
	if err != nil {
		s.mu.Lock()
		if s.probed == probed {
			s.probed = nil
		}
		s.mu.Unlock()
		return nil, err
	}
	probeMs := time.Since(probeStarted)
	s.mu.Lock()
	s.lastLocal = local
	s.mu.Unlock()
	out, err := s.rowsFromLocal(local)
	if err != nil {
		return nil, err
	}
	s.setLastRows(out)
	ok, miss := localInstalled(local)
	// TEMP(cli-inspect): 定位用，后续可随时移除
	s.logInspect(false, "cli-update inspect", fmt.Sprintf("total=%s probe=%s refreshLatest=%v cachedLatest=%v installed=%d missing=%d",
		time.Since(started).Round(time.Millisecond), probeMs.Round(time.Millisecond),
		willRefresh, !missing, ok, miss))
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

func scriptInstallDir(platform string) string {
	if platform == "" {
		platform = usage.Platform()
	}
	lib := nodepath.Lib(platform)
	home := usage.Homedir()
	if platform == "win32" {
		localAppData := util.JSTrim(os.Getenv("LOCALAPPDATA"))
		if localAppData == "" {
			localAppData = lib.Join(home, "AppData", "Local")
		}
		return lib.Join(localAppData, "agy", "bin")
	}
	return lib.Join(home, ".local", "bin")
}

func (s *CliUpdateService) checkScriptRequirements(kind, platform string) cuChecks {
	var c cuChecks
	c.requirements = []any{}
	sc := scriptForPlatform(kind, platform)
	if sc == "" {
		return c
	}
	if platform == "win32" {
		ps := s.findTool("powershell.exe", platform)
		detail := i18n.T("electron.common.not-found")
		if ps != "" {
			detail = ps
		}
		c.requirements = append(c.requirements, util.NewObj("id", "powershell", "ok", ps != "", "label", "PowerShell", "detail", detail))
		if ps == "" {
			c.blockers = append(c.blockers, i18n.T("electron.common.install-tool-not-found", "PowerShell"))
		}
	} else {
		bashBin := s.findTool("bash", platform)
		bashDetail := i18n.T("electron.common.not-found")
		if bashBin != "" {
			bashDetail = bashBin
		}
		c.requirements = append(c.requirements, util.NewObj("id", "bash", "ok", bashBin != "", "label", "bash", "detail", bashDetail))
		if bashBin == "" {
			c.blockers = append(c.blockers, i18n.T("electron.common.install-tool-not-found", "bash"))
		}
		if strings.Contains(sc, "curl") {
			curlBin := s.findTool("curl", platform)
			curlDetail := i18n.T("electron.common.not-found")
			if curlBin != "" {
				curlDetail = curlBin
			}
			c.requirements = append(c.requirements, util.NewObj("id", "curl", "ok", curlBin != "", "label", "curl", "detail", curlDetail))
			if curlBin == "" {
				c.blockers = append(c.blockers, i18n.T("electron.common.install-tool-not-found", "curl"))
			}
		}
	}
	dir := scriptInstallDir(platform)
	writable := s.probe.CanWrite(dir)
	c.requirements = append(c.requirements, util.NewObj("id", "write", "ok", writable, "label", i18n.T("electron.common.directory-writable"), "detail", dir))
	if !writable {
		c.blockers = append(c.blockers, i18n.T("electron.common.the-user-directory-is-not-writable", dir))
	}
	return c
}

func (s *CliUpdateService) plan(kind, scope string) cuPlanned {
	platform := s.effectivePlatform()
	bin := ResolveCliBinAsync(kind)
	mode := "install"
	if bin != "" {
		mode = "update"
	}
	method := GuessInstallMethod(bin)
	if kind == "dsh" && bin != "" {
		method = "npm"
	}
	recipes := UpdateRecipesForPlatform(kind, bin, method, scope, platform)
	if len(recipes) == 0 {
		blocker := i18n.T("electron.common.the-command-is-not-on-the-allow-list")
		plan := util.NewObj("kind", kind, "mode", mode, "scope", scope, "argv", []any{},
			"command", "", "requirements", []any{}, "blockers", cuStrs([]string{blocker}))
		return cuPlanned{plan: plan, argv: []string{}, command: "", mode: mode, blocks: []string{blocker}, recipes: recipes}
	}
	first := recipes[0]
	checks := cuChecks{requirements: []any{}}
	if first.Via == "npm" {
		checks = s.checkRequirements(kind, scope)
	} else if first.Via == "script" {
		checks = s.checkScriptRequirements(kind, platform)
	}
	blockers := append([]string{}, checks.blockers...)
	if !IsAllowedUpdateArgv(first.Argv) {
		blockers = append([]string{i18n.T("electron.common.the-command-is-not-on-the-allow-list")}, blockers...)
	}
	cmd := CommandLine(first.Argv)
	if first.Via == "script" {
		if _, displayCmd := scriptArgvForPlatform(kind, platform); displayCmd != "" {
			cmd = displayCmd
		}
	}
	plan := util.NewObj("kind", kind, "mode", mode, "scope", scope, "argv", cuStrs(first.Argv),
		"command", cmd, "requirements", checks.requirements, "blockers", cuStrs(blockers))
	if checks.needsUserScope {
		plan.Set("userScopeCommand", CommandLine(UpdateRecipesForPlatform(kind, bin, "npm", "user", platform)[0].Argv))
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
	s.mu.Lock()
	s.probed = nil
	s.mu.Unlock()
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
	if bin := ResolveCliBinAsync(kind); bin != "" && MockCliUpdate(bin, ReadVersionAsync(bin)) {
		return cuResult(false, i18n.T("electron.common.mock-coding-assistant-is-not-updated-from-nomi"), "")
	}
	planned := s.plan(kind, scope)
	if len(planned.blocks) > 0 {
		return cuResult(false, strings.Join(planned.blocks, "\n"), "")
	}
	platform := s.effectivePlatform()
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
	usedScript := false
	recipes := planned.recipes
	for i, recipe := range recipes {
		if recipe.Via == "npm" && i != 0 {
			again := s.checkRequirements(kind, scope)
			if len(again.blockers) > 0 {
				logs = append(logs, again.blockers...)
				break
			}
		} else if recipe.Via == "script" && i != 0 {
			again := s.checkScriptRequirements(kind, platform)
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
		if recipe.Via == "script" {
			if sc := scriptForPlatform(kind, platform); sc != "" {
				line = "$ " + sc
			}
		}
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
			usedScript = recipe.Via == "script"
			break
		}
		var code any = "—"
		if res.Code != nil {
			code = float64(*res.Code)
		}
		logs = append(logs, i18n.T("electron.common.command-failed-exit-code", code))
	}
	log := util.UTF16Tail(strings.Join(logs, "\n"), 8000)
	if ok {
		ForgetMissingCliBins()
		if usedScript {
			RememberCliDir(scriptInstallDir(platform))
		}
	}
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
