package cli

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

var envBin = map[string]string{
	"claude": "NOMI_CLAUDE_BIN", "codex": "NOMI_CODEX_BIN", "dsh": "NOMI_DSH_BIN",
	"grok": "NOMI_GROK_BIN", "gemini": "NOMI_GEMINI_BIN", "cursor": "NOMI_CURSOR_BIN",
}

var candidates = map[string][]string{
	"claude": {"claude"}, "codex": {"codex"}, "dsh": {"dsh"}, "grok": {"grok"},
	"gemini": {"gemini"}, "cursor": {"cursor-agent", "agent"},
}

// MockCliRoots：Node 版前两项是相对 __dirname 的 bundle 目录（Go 二进制没有 __dirname；
// 宿主在 batch 4/5 wiring 时把打包后的 mock-cli 目录 prepend 进来）。后两项与 Node 相同（相对 cwd）。
var MockCliRoots = func() []string {
	cwd, _ := os.Getwd()
	return []string{
		filepath.Join(cwd, "packages/core/scripts/mock-cli"),
		filepath.Join(cwd, "scripts/mock-cli"),
	}
}

// MockCliBin = mockCliBin（"" = null）。
func MockCliBin(kind string) string {
	if os.Getenv("NOMI_USE_MOCK_CLI") != "1" || kind == "cursor" {
		return ""
	}
	for _, dir := range MockCliRoots() {
		f := filepath.Join(dir, "mock-"+kind+".mjs")
		if usage.ExistsSync(f) {
			return f
		}
	}
	return ""
}

var (
	detMu          sync.Mutex
	rememberedDirs []string
)

// RememberCliDir = rememberCliDir。
func RememberCliDir(dir string) {
	d := util.JSTrim(dir)
	detMu.Lock()
	for _, x := range rememberedDirs {
		if x == d {
			detMu.Unlock()
			return
		}
	}
	if d == "" {
		detMu.Unlock()
		return
	}
	rememberedDirs = append([]string{d}, rememberedDirs...)
	detMu.Unlock()
	ForgetMissingCliBins()
}

// ForgetMissingCliBins = forgetMissingCliBins。
func ForgetMissingCliBins() {
	detMu.Lock()
	defer detMu.Unlock()
	for k, hit := range binCache {
		if hit.bin == "" {
			delete(binCache, k)
		}
	}
	nodeBinCache = nil
}

// NpmPrefixBinDir = npmPrefixBinDir。
func NpmPrefixBinDir(prefix, platform string) string {
	if platform == "" {
		platform = usage.Platform()
	}
	if platform == "win32" {
		return prefix
	}
	return filepath.Join(prefix, "bin")
}

var nvmVerRe = regexp.MustCompile(`^v?\d+\.\d+\.\d+`)

func envStr(env *util.Obj, k string) string { s, _ := usage.Str(env, k); return s }

func nvmBinDirs(home string, env *util.Obj) []string {
	out := []string{}
	if b := util.JSTrim(envStr(env, "NVM_BIN")); b != "" {
		out = append(out, b)
	}
	nvmDir := util.JSTrim(envStr(env, "NVM_DIR"))
	if nvmDir == "" {
		nvmDir = filepath.Join(home, ".nvm")
	}
	root := filepath.Join(nvmDir, "versions", "node")
	names, err := readdirNames(root)
	if err != nil {
		return out
	}
	versions := []string{}
	for _, v := range names {
		if nvmVerRe.MatchString(v) {
			versions = append(versions, v)
		}
	}
	parts := func(s string) []float64 {
		ps := strings.Split(strings.TrimPrefix(s, "v"), ".")
		r := make([]float64, len(ps))
		for i, p := range ps {
			r[i] = util.ToNumber(p)
		}
		return r
	}
	at := func(a []float64, i int) float64 {
		if i < len(a) {
			return a[i]
		}
		return 0
	}
	sort.SliceStable(versions, func(i, j int) bool {
		pa, pb := parts(versions[i]), parts(versions[j])
		for k := 0; k < 3; k++ {
			x, y := at(pa, k), at(pb, k)
			if x != y { // pb[i] - pa[i] < 0 ⇒ a 在前（NaN 比较为 false，视作相等 —— 与 V8 TimSort 对 NaN 返回值一致）
				return y-x < 0
			}
		}
		return false
	})
	for _, v := range versions {
		out = append(out, filepath.Join(root, v, "bin"))
	}
	return out
}

// readdirNames = fs.readdirSync（OS 顺序，与 libuv scandir 一致：不排序）。
func readdirNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

func unique(dirs []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, d := range dirs {
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return out
}

func remembered() []string {
	detMu.Lock()
	defer detMu.Unlock()
	return append([]string{}, rememberedDirs...)
}

func orDefault(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// CliSearchDirs = cliSearchDirs（home "" = os.homedir()，platform "" = process.platform，env nil = process.env）。
func CliSearchDirs(home, platform string, env *util.Obj) []string {
	if home == "" {
		home = usage.Homedir()
	}
	if platform == "" {
		platform = usage.Platform()
	}
	if env == nil {
		env = usage.ProcessEnv()
	}
	t := func(k string) string { return util.JSTrim(envStr(env, k)) }
	if platform == "win32" {
		winHome := orDefault(t("USERPROFILE"), home)
		appData := orDefault(t("APPDATA"), filepath.Join(winHome, "AppData", "Roaming"))
		localAppData := orDefault(t("LOCALAPPDATA"), filepath.Join(winHome, "AppData", "Local"))
		d := remembered()
		if p := t("NPM_CONFIG_PREFIX"); p != "" {
			d = append(d, p)
		}
		d = append(d, filepath.Join(winHome, ".grok", "bin"), filepath.Join(appData, "npm"), filepath.Join(winHome, ".local"))
		if p := t("PNPM_HOME"); p != "" {
			d = append(d, p)
		}
		d = append(d, filepath.Join(localAppData, "pnpm"),
			filepath.Join(orDefault(t("VOLTA_HOME"), filepath.Join(localAppData, "Volta")), "bin"),
			filepath.Join(winHome, ".bun", "bin"))
		return unique(d)
	}
	d := remembered()
	if p := t("NPM_CONFIG_PREFIX"); p != "" {
		d = append(d, filepath.Join(p, "bin"))
	}
	d = append(d,
		filepath.Join(home, ".grok", "bin"),
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".local", "npm-global", "bin"),
		filepath.Join(home, ".npm-packages", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin")
	d = append(d, nvmBinDirs(home, env)...)
	d = append(d, filepath.Join(orDefault(t("VOLTA_HOME"), filepath.Join(home, ".volta")), "bin"))
	if p := t("PNPM_HOME"); p != "" {
		d = append(d, p)
	}
	d = append(d,
		filepath.Join(home, "Library", "pnpm"),
		filepath.Join(home, ".local", "share", "pnpm"),
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".asdf", "shims"),
		filepath.Join(home, ".local", "share", "mise", "shims"),
		filepath.Join(home, ".claude", "local"))
	return unique(d)
}

func pathKey(env *util.Obj) string {
	for _, k := range env.Keys() {
		if util.JSLower(k) == "path" {
			return k
		}
	}
	return "PATH"
}

func splitNonEmpty(s, sep string) []string {
	out := []string{}
	for _, p := range strings.Split(s, sep) {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// WithCliPath = withCliPath（base nil = process.env）。
func WithCliPath(base *util.Obj) *util.Obj {
	if base == nil {
		base = usage.ProcessEnv()
	}
	key := pathKey(base)
	delim := string(os.PathListSeparator)
	cur := splitNonEmpty(envStr(base, key), delim)
	home := orDefault(util.JSTrim(envStr(base, "USERPROFILE")), orDefault(util.JSTrim(envStr(base, "HOME")), usage.Homedir()))
	all := append([]string{}, cur...)
	for _, d := range CliSearchDirs(home, usage.Platform(), base) {
		in := false
		for _, c := range cur {
			if c == d {
				in = true
				break
			}
		}
		if !in && usage.ExistsSync(d) {
			all = append(all, d)
		}
	}
	out := base.Clone()
	out.Set(key, strings.Join(all, delim))
	return out
}

var (
	winExeRe = regexp.MustCompile(`(?i)\.(?:exe|cmd|bat|com)$`)
	hasExtRe = regexp.MustCompile(`(?i)\.[a-z0-9]+$`)
)

// WindowsExecutable = windowsExecutable（exists nil = fs.existsSync）。
func WindowsExecutable(bin, platform string, exists func(string) bool) string {
	if platform == "" {
		platform = usage.Platform()
	}
	if exists == nil {
		exists = usage.ExistsSync
	}
	if platform != "win32" || winExeRe.MatchString(bin) {
		return bin
	}
	for _, ext := range []string{".exe", ".cmd", ".bat"} {
		if exists(bin + ext) {
			return bin + ext
		}
	}
	return bin
}

// ResolveNpmBin = resolveNpmBin（"" = null）。
func ResolveNpmBin() string {
	if e := util.JSTrim(os.Getenv("NOMI_NPM_BIN")); e != "" && usage.ExistsSync(e) {
		return e
	}
	name := "npm"
	if usage.Platform() == "win32" {
		name = "npm.cmd"
	}
	if p := which(name); p != "" {
		return p
	}
	return which("npm")
}

func onDiskCase(file string) string {
	dir, base := filepath.Dir(file), filepath.Base(file)
	names, err := readdirNames(dir)
	if err != nil {
		return file
	}
	for _, n := range names {
		if n == base {
			return file
		}
	}
	lower := util.JSLower(base)
	for _, n := range names {
		if util.JSLower(n) == lower {
			return filepath.Join(dir, n)
		}
	}
	return file
}

// FindOnPath = findOnPath（"" = null）。
func FindOnPath(cmd string, env *util.Obj, platform string, exists func(string) bool) string {
	if env == nil {
		env = usage.ProcessEnv()
	}
	if platform == "" {
		platform = usage.Platform()
	}
	if exists == nil {
		exists = usage.ExistsSync
	}
	dirs := splitNonEmpty(envStr(env, pathKey(env)), string(os.PathListSeparator))
	if len(dirs) == 0 {
		return ""
	}
	names := []string{}
	if platform == "win32" {
		if hasExtRe.MatchString(cmd) {
			names = append(names, cmd)
		} else {
			pathext := ".COM;.EXE;.BAT;.CMD"
			if v, ok := env.Lookup("PATHEXT"); ok {
				if _, u := v.(util.JSUndefined); !u && v != nil {
					pathext = util.JSString(v)
				}
			}
			for _, raw := range strings.Split(pathext, ";") {
				ext := util.JSTrim(raw)
				if ext == "" {
					continue
				}
				if !strings.HasPrefix(ext, ".") {
					ext = "." + ext
				}
				names = append(names, cmd+ext)
			}
			names = append(names, cmd)
		}
	} else {
		names = append(names, cmd)
	}
	for _, dir := range dirs {
		for _, name := range names {
			c := filepath.Join(dir, name)
			if !exists(c) {
				continue
			}
			found := WindowsExecutable(c, platform, exists)
			if exists(found) {
				if platform == "win32" {
					return onDiskCase(found)
				}
				return found
			}
		}
	}
	return ""
}

func which(cmd string) string { return FindOnPath(cmd, WithCliPath(nil), "", nil) }

type binHit struct {
	bin string
	at  time.Time
}

var nodeBinCache *binHit

// ResolveNodeBin = resolveNodeBin（"" = null；30s 缓存）。
func ResolveNodeBin() string {
	detMu.Lock()
	c := nodeBinCache
	detMu.Unlock()
	if c != nil && time.Since(c.at) < 30*time.Second && (c.bin == "" || usage.ExistsSync(c.bin)) {
		return c.bin
	}
	name := "node"
	if usage.Platform() == "win32" {
		name = "node.exe"
	}
	bin := which(name)
	if bin == "" && name == "node.exe" {
		bin = which("node")
	}
	detMu.Lock()
	nodeBinCache = &binHit{bin, time.Now()}
	detMu.Unlock()
	return bin
}

const missingTTL = 10 * time.Second

var binCache = map[string]binHit{}

func cacheBin(kind, bin string) string {
	detMu.Lock()
	binCache[kind] = binHit{bin, time.Now()}
	detMu.Unlock()
	return bin
}

// PeekCliBin = peekCliBin：(bin, true) 命中（bin "" = 缓存的 null）；ok=false = undefined。
func PeekCliBin(kind string) (string, bool) {
	if e := pickedBin(os.Getenv(envBin[kind])); e != "" {
		return e, true
	}
	if m := MockCliBin(kind); m != "" {
		return m, true
	}
	detMu.Lock()
	hit, ok := binCache[kind]
	detMu.Unlock()
	if !ok {
		return "", false
	}
	if hit.bin != "" {
		if usage.ExistsSync(hit.bin) {
			return hit.bin, true
		}
		detMu.Lock()
		delete(binCache, kind)
		detMu.Unlock()
		return "", false
	}
	if time.Since(hit.at) > missingTTL {
		detMu.Lock()
		delete(binCache, kind)
		detMu.Unlock()
		return "", false
	}
	return "", true
}

// ResolveCliBinCached = resolveCliBinCached。
func ResolveCliBinCached(kind string) string {
	if b, ok := PeekCliBin(kind); ok {
		return b
	}
	return cacheBin(kind, ResolveCliBin(kind))
}

var inflight = map[string]*jsrt.Promise[string]{}

// RefreshCliBin = refreshCliBin（同一后端并发合并）。须在 jsrt 线程内调用。
func RefreshCliBin(kind string) *jsrt.Promise[string] {
	detMu.Lock()
	if p := inflight[kind]; p != nil {
		detMu.Unlock()
		return p
	}
	p := jsrt.NewPromise[string]()
	inflight[kind] = p
	detMu.Unlock()
	jsrt.Go(func() {
		v := ResolveCliBinAsync(kind)
		detMu.Lock()
		delete(inflight, kind)
		detMu.Unlock()
		p.Resolve(v)
	})
	return p
}

// ResetCliBinCache = resetCliBinCache。
func ResetCliBinCache() {
	detMu.Lock()
	defer detMu.Unlock()
	binCache = map[string]binHit{}
	rememberedDirs = nil
	inflight = map[string]*jsrt.Promise[string]{}
	nodeBinCache = nil
}

func pickedBin(raw string) string {
	e := util.JSTrim(raw)
	if e == "" {
		return ""
	}
	chosen := WindowsExecutable(e, "", nil)
	if usage.ExistsSync(chosen) {
		return chosen
	}
	return ""
}

func fallbackNames(kind string) []string {
	if usage.Platform() != "win32" {
		return candidates[kind]
	}
	out := []string{}
	for _, c := range candidates[kind] {
		out = append(out, c+".cmd", c+".exe", c)
	}
	return out
}

func probe(kind string, whichFn func(string) string) string {
	if e := pickedBin(os.Getenv(envBin[kind])); e != "" {
		return e
	}
	if m := MockCliBin(kind); m != "" {
		return m
	}
	for _, c := range candidates[kind] {
		if p := whichFn(c); p != "" {
			return p
		}
	}
	for _, dir := range CliSearchDirs("", "", nil) {
		for _, c := range fallbackNames(kind) {
			p := filepath.Join(dir, c)
			if usage.ExistsSync(p) {
				return p
			}
		}
	}
	return ""
}

// ResolveCliBin = resolveCliBin（"" = null）。
func ResolveCliBin(kind string) string { return probe(kind, which) }

var versionRe = regexp.MustCompile(`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`)

// execOpts 生成 execFile(Sync) 的 spawn 参数：shell:true 在 Windows 上 = `cmd.exe /d /s /c "<file args…>"`（verbatim）。
func execOpts(file string, args []string, shell bool) (string, []string, bool) {
	if !shell {
		return file, args, false
	}
	command := strings.Join(append([]string{file}, args...), " ")
	if usage.Platform() == "win32" {
		comspec := os.Getenv("comspec")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return comspec, []string{"/d", "/s", "/c", `"` + command + `"`}, true
	}
	return "/bin/sh", []string{"-c", command}, false
}

func execText(file string, args []string, env *util.Obj, timeoutMs int, shell bool) (string, error) {
	f, a, verbatim := execOpts(file, args, shell)
	out, err := nodeproc.RunSync(f, a, nodeproc.Options{Env: usage.EnvSlice(env), Verbatim: verbatim, IgnoreStdin: true}, time.Duration(timeoutMs)*time.Millisecond)
	return nodeproc.DecodeChunk(out), err
}

func isCmdBat(bin string) bool { return cmdBatRe.MatchString(bin) }

var cmdBatRe = regexp.MustCompile(`(?i)\.(cmd|bat)$`)

func versionOf(out string) string {
	if m := versionRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	t := util.UTF16Slice0(util.JSTrim(out), 64)
	return t
}

// ReadVersion = readVersion（"" = null）。
func ReadVersion(bin string) string {
	env := WithCliPath(nil)
	env.Set("NO_COLOR", "1")
	out, err := execText(bin, []string{"--version"}, env, 8000, usage.Platform() == "win32" && isCmdBat(bin))
	if err != nil {
		return ""
	}
	return versionOf(out)
}

var (
	nvmPathRe = regexp.MustCompile(`/\.nvm/versions/node/|/\.volta/|/fnm|/\.asdf/|/mise/|/pnpm/|/\.bun/|/\.npm-packages/`)
)

// GuessInstallMethod = guessInstallMethod。
func GuessInstallMethod(bin string) string {
	if bin == "" {
		return "unknown"
	}
	n := util.JSLower(strings.ReplaceAll(bin, `\`, "/"))
	if strings.Contains(n, "node_modules") || strings.Contains(n, "npm-global") {
		return "npm"
	}
	if nvmPathRe.MatchString(n) {
		return "npm"
	}
	if strings.Contains(n, "/.local/share/claude") || strings.Contains(n, "/versions/") {
		return "native"
	}
	return "unknown"
}

var semverOnlyRe = regexp.MustCompile(`(\d+\.\d+\.\d+)`)

// FetchNpmLatest = fetchNpmLatest（"" = null）。阻塞执行；调用方在 jsrt.Async 中使用。
func FetchNpmLatest(pkg string, timeoutMs int) string {
	if timeoutMs == 0 {
		timeoutMs = 12_000
	}
	npm := ResolveNpmBin()
	if npm == "" {
		npm = "npm"
		if usage.Platform() == "win32" {
			npm = "npm.cmd"
		}
	}
	out, err := execText(npm, []string{"view", pkg, "version", "--json"}, WithCliPath(nil), timeoutMs, usage.Platform() == "win32")
	if err != nil {
		return ""
	}
	v, perr := util.ParseString(util.JSTrim(out))
	if perr == nil {
		if s, ok := v.(string); ok {
			return s
		}
		return ""
	}
	if m := semverOnlyRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// NpmPkg = NPM_PKG。
var NpmPkg = map[string]string{
	"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex", "dsh": "@deepseek-ai/dsh",
	"grok": "@xai-official/grok", "gemini": "@google/gemini-cli",
}

// CliMinNodeMajor = CLI_MIN_NODE_MAJOR。
var CliMinNodeMajor = map[string]int{"claude": 22, "codex": 16, "dsh": 24, "grok": 18, "gemini": 20}

const DshMinNodeMajor = 24

var nodeVerRe = regexp.MustCompile(`v?(\d+\.\d+\.\d+)`)

// ReadPathNodeVersion = readPathNodeVersion（"" = null）。
func ReadPathNodeVersion() string {
	name := "node"
	if usage.Platform() == "win32" {
		name = "node.exe"
	}
	out, err := execText(name, []string{"--version"}, WithCliPath(nil), 5000, false)
	if err != nil {
		return ""
	}
	if m := nodeVerRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// DshProblem = dshRuntimeProblem 的返回（nil = null）。NodeVersion nil = null。
type DshProblem struct {
	NodeVersion *string
	Required    int
}

// DshRuntimeProblem = dshRuntimeProblem(nodeVersion)。
func DshRuntimeProblem(nodeVersion *string) *DshProblem {
	if nodeVersion != nil && *nodeVersion != "" {
		major := util.ToNumber(strings.Split(*nodeVersion, ".")[0])
		if !math.IsNaN(major) && !math.IsInf(major, 0) && major >= DshMinNodeMajor {
			return nil
		}
	}
	return &DshProblem{NodeVersion: nodeVersion, Required: DshMinNodeMajor}
}

// ---- 异步版本：在 jsrt 线程内调用；阻塞部分释放 GIL（= Node 不卡主线程）。

func offThread[T any](fn func() T) T {
	p := jsrt.NewPromise[T]()
	go func() { p.Resolve(fn()) }()
	v, _ := jsrt.Await(p)
	return v
}

// ResolveNpmBinAsync = resolveNpmBinAsync。
func ResolveNpmBinAsync() string {
	WaitForShellPath(0)
	if e := util.JSTrim(os.Getenv("NOMI_NPM_BIN")); e != "" && usage.ExistsSync(e) {
		return e
	}
	name := "npm"
	if usage.Platform() == "win32" {
		name = "npm.cmd"
	}
	if p := which(name); p != "" {
		return p
	}
	return which("npm")
}

// ResolveCliBinAsync = resolveCliBinAsync（写缓存）。
func ResolveCliBinAsync(kind string) string {
	WaitForShellPath(0)
	return cacheBin(kind, probe(kind, which))
}

// ReadVersionAsync = readVersionAsync。
func ReadVersionAsync(bin string) string { return offThread(func() string { return ReadVersion(bin) }) }

// ReadPathNodeVersionAsync = readPathNodeVersionAsync。
func ReadPathNodeVersionAsync() string { return offThread(ReadPathNodeVersion) }

// DshRuntimeProblemAsync = dshRuntimeProblemAsync。
func DshRuntimeProblemAsync() *DshProblem {
	// readPathNodeVersion 只返回匹配到的版本或 null，"" 即 null
	v := ReadPathNodeVersionAsync()
	if v == "" {
		return DshRuntimeProblem(nil)
	}
	return DshRuntimeProblem(&v)
}

func init() {
	usage.DefaultGrokBin = func() (string, bool) {
		b := ResolveCliBinAsync("grok")
		return b, b != ""
	}
	usage.DefaultCliEnv = func() *util.Obj { return WithCliPath(nil) }
	usage.DefaultClaudeBin = func() (string, bool) {
		b := ResolveCliBinAsync("claude")
		return b, b != ""
	}
	usage.DefaultCodexBin = func() (string, bool) {
		b := ResolveCliBinAsync("codex")
		return b, b != ""
	}
}
