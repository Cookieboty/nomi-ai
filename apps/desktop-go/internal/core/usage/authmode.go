package usage

// authmode.go = packages/core/src/usage/authMode.ts（不读取任何凭据内容；只看官方登录状态命令的结论与配置里「是否配了」）。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// AuthMode：subscription / api / unknown；"" = null。
const (
	AuthSubscription = "subscription"
	AuthAPI          = "api"
	AuthUnknown      = "unknown"
)

// ParseClaudeAuthStatus = parseClaudeAuthStatus（"" = null）。
func ParseClaudeAuthStatus(text string) string {
	v, err := util.Parse([]byte(text))
	if err != nil {
		return ""
	}
	j, _ := v.(*util.Obj)
	m, ok := j.Get("authMethod").(string)
	if !ok {
		return ""
	}
	switch m {
	case "claude.ai", "oauth_token":
		if p, ok := j.Get("apiProvider").(string); ok && p != "firstParty" {
			return AuthAPI
		}
		return AuthSubscription
	case "api_key", "api_key_helper", "third_party":
		return AuthAPI
	case "none":
		return AuthUnknown
	}
	return ""
}

func clip(v any, max int) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	t := util.JSTrim(s)
	if t == "" || util.UTF16Len(s) > max {
		return nil
	}
	return &t
}

// ClaudeIdentity = parseClaudeIdentity 的返回（FP nil = null；Plan "" = 无）。
type ClaudeIdentity struct {
	FP   *string
	Plan string
}

// capitalize = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()（UTF-16 单元）。
func capitalize(s string) string {
	n := util.UTF16Prefix(s, 1)
	return cases.Upper(language.Und).String(s[:n]) + util.JSLower(s[n:])
}

// ParseClaudeIdentity = parseClaudeIdentity。
func ParseClaudeIdentity(text, salt string) ClaudeIdentity {
	v, err := util.Parse([]byte(text))
	o, _ := v.(*util.Obj)
	if err != nil || o == nil {
		return ClaudeIdentity{}
	}
	plan := clip(o.Get("subscriptionType"), 24)
	email := clip(o.Get("email"), 320)
	org := clip(o.Get("orgId"), 80)
	if org == nil {
		org = clip(o.Get("organizationId"), 80)
	}
	var out ClaudeIdentity
	if fp, ok := Fingerprint(salt, []*string{email, org, plan}); ok {
		out.FP = &fp
	}
	if plan != nil {
		out.Plan = capitalize(*plan)
	}
	return out
}

var notLoggedInRe = regexp.MustCompile(`[Nn][Oo][Tt] [Ll][Oo][Gg][Gg][Ee][Dd] [Ii][Nn]`)

// IsDefinitelySignedOut = isDefinitelySignedOut。
func IsDefinitelySignedOut(kind, text string) bool {
	if kind == "codex" {
		return notLoggedInRe.MatchString(text)
	}
	v, err := util.Parse([]byte(text))
	if err != nil {
		return false
	}
	j, _ := v.(*util.Obj)
	return j.Get("authMethod") == "none"
}

var (
	codexAPIKeyRe = regexp.MustCompile(`using an? api key`)
)

// ParseCodexLoginStatus = parseCodexLoginStatus（"" = null）。
func ParseCodexLoginStatus(text string) string {
	s := util.JSLower(text)
	if strings.Contains(s, "not logged in") {
		return AuthUnknown
	}
	if codexAPIKeyRe.MatchString(s) {
		return AuthAPI
	}
	if strings.Contains(s, "using chatgpt") {
		return AuthSubscription
	}
	return ""
}

var claudeAPIKeys = []string{
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
}

func isConfigured(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		n := util.JSLower(util.JSTrim(x))
		return n != "" && n != "0" && n != "false"
	}
	return v != nil
}

func asRecord(v any) *util.Obj { o, _ := v.(*util.Obj); return o }

// HasCustomClaudeConfiguration = hasCustomClaudeConfiguration。
func HasCustomClaudeConfiguration(env *util.Obj, docs []any) bool {
	for _, k := range claudeAPIKeys {
		if isConfigured(env.Get(k)) {
			return true
		}
	}
	for _, d := range docs {
		s := asRecord(d)
		if s == nil {
			continue
		}
		if isConfigured(s.Get("apiKeyHelper")) {
			return true
		}
		if e := asRecord(s.Get("env")); e != nil {
			for _, k := range claudeAPIKeys {
				if isConfigured(e.Get(k)) {
					return true
				}
			}
		}
	}
	return false
}

// readUTF8 = fs.readFileSync(p, 'utf8')。
func readUTF8(p string) (string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return nodeproc.DecodeChunk(b), nil
}

func readJSON(p string) (any, bool) {
	s, err := readUTF8(p)
	if err != nil {
		return nil, false
	}
	v, err := util.Parse([]byte(s))
	if err != nil {
		return nil, false
	}
	return v, true
}

// ReadClaudeSettingsDocs = readClaudeSettingsDocs。
func ReadClaudeSettingsDocs(home string, env *util.Obj) []any {
	dir := ClaudeConfigDir(home, env)
	out := []any{}
	for _, name := range []string{"settings.json", "settings.local.json"} {
		if v, ok := readJSON(filepath.Join(dir, name)); ok {
			out = append(out, v)
		}
	}
	return out
}

// ClaudeOAuthPresent = claudeOAuthPresent（nil = null）。
func ClaudeOAuthPresent(home string, env *util.Obj) *bool {
	t, f := true, false
	if isConfigured(env.Get("CLAUDE_CODE_OAUTH_TOKEN")) {
		return &t
	}
	file := filepath.Join(home, ".claude.json")
	if util.Truthy(env.Get("CLAUDE_CONFIG_DIR")) {
		file = filepath.Join(ClaudeConfigDir(home, env), ".claude.json")
	}
	v, ok := readJSON(file)
	if !ok {
		return nil
	}
	j := asRecord(v)
	if j == nil {
		return nil
	}
	if a := asRecord(j.Get("oauthAccount")); a != nil && a.Len() > 0 {
		return &t
	}
	return &f
}

// ClaudeAuthFromConfig = claudeAuthFromConfig（"" = null）。
func ClaudeAuthFromConfig(home string, env *util.Obj) string {
	if HasCustomClaudeConfiguration(env, ReadClaudeSettingsDocs(home, env)) {
		return AuthAPI
	}
	return ""
}

// JS \s（WhiteSpace + LineTerminator）与 /m 的行首（\n \r U+2028 U+2029 之后）。
const (
	jsWS   = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`
	jsLine = `(?:^|[\n\r\x{2028}\x{2029}])`
)

var (
	tomlTableRe  = regexp.MustCompile(`(^|[\n\r\x{2028}\x{2029}])[` + jsWS + `]*\[`)
	tomlForcedRe = regexp.MustCompile(jsLine + `[` + jsWS + `]*forced_login_method[` + jsWS + `]*=[` + jsWS + `]*"(\w+)"`)
	tomlProvRe   = regexp.MustCompile(jsLine + `[` + jsWS + `]*model_provider[` + jsWS + `]*=[` + jsWS + `]*"([^"]+)"`)
)

// CodexAuthFromConfig = codexAuthFromConfig（"" = null）。
func CodexAuthFromConfig(home string, env *util.Obj) string {
	toml, err := readUTF8(filepath.Join(CodexHomeDir(home, env), "config.toml"))
	if err != nil {
		return ""
	}
	top := toml
	if m := tomlTableRe.FindStringSubmatchIndex(toml); m != nil {
		top = toml[:m[3]]
	}
	if m := tomlForcedRe.FindStringSubmatch(top); m != nil {
		if m[1] == "api" {
			return AuthAPI
		}
		if m[1] == "chatgpt" {
			return AuthSubscription
		}
	}
	if m := tomlProvRe.FindStringSubmatch(top); m != nil && m[1] != "openai" {
		return AuthAPI
	}
	return ""
}

var grokAPIKeys = []string{"XAI_API_KEY", "GROK_API_KEY", "GROK_DEPLOYMENT_KEY", "NOMI_GROK_API_KEY"}

// ciASCII：JS /i（非 u 模式）只做 ASCII 大小写折叠；RE2 的 (?i) 还会把 k/s 折叠到 K(U+212A)/ſ，故显式展开。
func ciASCII(s string) string {
	var b strings.Builder
	for _, c := range s {
		l, u := strings.ToLower(string(c)), strings.ToUpper(string(c))
		if l != u {
			b.WriteString("[" + u + l + "]")
		} else {
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	return b.String()
}

var grokEnvKeyRe = regexp.MustCompile(`(?:^|\n)[` + jsWS + `]*` + ciASCII("env_key") + `[` + jsWS + `]*=[` + jsWS + `]*"(?:` +
	ciASCII("XAI_API_KEY") + `|` + ciASCII("GROK_API_KEY") + `|` + ciASCII("GROK_DEPLOYMENT_KEY") + `|` + ciASCII("NOMI_GROK_API_KEY") + `)"`)

// HasManagedGrokConfiguration = hasManagedGrokConfiguration。
func HasManagedGrokConfiguration(home string, env *util.Obj) bool {
	config, err := readUTF8(filepath.Join(GrokHomeDir(home, env), "config.toml"))
	if err != nil {
		return false
	}
	return strings.Contains(config, "# >>> nomi managed (grok provider) >>>") || grokEnvKeyRe.MatchString(config)
}

// HasCustomGrokConfiguration = hasCustomGrokConfiguration。
func HasCustomGrokConfiguration(home string, env *util.Obj) bool {
	for _, k := range grokAPIKeys {
		if isConfigured(env.Get(k)) {
			return true
		}
	}
	return HasManagedGrokConfiguration(home, env)
}

// GrokAuthFromConfig = grokAuthFromConfig（"" = null）。
func GrokAuthFromConfig(home string, env *util.Obj) string {
	if HasCustomGrokConfiguration(home, env) {
		return AuthAPI
	}
	return ""
}

// HasGrokLocalPresence = hasGrokLocalPresence（= hasGrokAuthFile）。
func HasGrokLocalPresence(home string, env *util.Obj) bool {
	dir := GrokHomeDir(home, env)
	return ExistsSync(filepath.Join(dir, "config.toml")) || ExistsSync(filepath.Join(dir, "sessions"))
}

// AuthInfo：登录方式 + 非敏感身份信息。FP nil = null；Plan "" = 无。
type AuthInfo struct {
	Mode      string
	FP        *string
	Plan      string
	SignedOut bool
	FromCli   bool
}

func (a AuthInfo) ToObj() *util.Obj {
	var fp any
	if a.FP != nil {
		fp = *a.FP
	}
	o := util.NewObj("mode", a.Mode, "fp", fp)
	if a.Plan != "" {
		o.Set("plan", a.Plan)
	}
	if a.SignedOut {
		o.Set("signedOut", true)
	}
	if a.FromCli {
		o.Set("fromCli", true)
	}
	return o
}

func (a AuthInfo) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(a.ToObj())), nil }

// AuthDeps = AuthDeps。Run / GrokRun 返回 ("", false) = null；panic = reject（按 null 处理）。
type AuthDeps struct {
	Home                string
	Env                 *util.Obj
	Now                 func() float64
	Run                 func(kind string) (string, bool)
	GrokRun             func() (string, bool)
	HasSubscriptionData func(id string) bool
	Salt                func() string
	EnvFor              func(id string) *util.Obj
}

const authTTLMs = 5 * 60_000

// DefaultCliBin = resolveCliBinAsync(kind)（core/cli 在 init 时接上；"" = 没有）。
var DefaultCliBin func(kind string) string

var cmdBatExtRe = regexp.MustCompile(`(?i)\.(cmd|bat)$`)

// runStatus = runStatus（"" , false = null）。须持锁调用（阻塞部分让出锁）。
func runStatus(kind string, base *util.Obj) (string, bool) {
	if base == nil && DefaultCliEnv != nil {
		base = DefaultCliEnv()
	}
	if kind == "grok" {
		b := base
		return ReadGrokAuthStatus(GrokAuthReaderDeps{Env: func() *util.Obj { return b }})
	}
	if DefaultCliBin == nil {
		return "", false
	}
	bin := DefaultCliBin(kind)
	if bin == "" {
		return "", false
	}
	args := []string{"login", "status"}
	if kind == "claude" {
		args = []string{"auth", "status"}
	}
	env := base.Clone()
	env.Set("NO_COLOR", "1")
	file, argv, verbatim := bin, args, false
	if Platform() == "win32" && cmdBatExtRe.MatchString(bin) {
		comspec := os.Getenv("comspec")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		file, argv, verbatim = comspec, []string{"/d", "/s", "/c", `"` + strings.Join(append([]string{bin}, args...), " ") + `"`}, true
	}
	type res struct {
		out, errb []byte
		err       error
	}
	p := jsrt.NewPromise[res]()
	go func() {
		o, e, err := nodeproc.ExecFile(file, argv, nodeproc.Options{Env: EnvSlice(env), Verbatim: verbatim, IgnoreStdin: true}, 6000*time.Millisecond, 64*1024)
		p.Resolve(res{o, e, err})
	}()
	r, _ := jsrt.Await(p)
	out := nodeproc.DecodeChunk(r.out) + "\n" + nodeproc.DecodeChunk(r.errb)
	if r.err == nil {
		return out, true
	}
	if util.JSTrim(out) != "" {
		return out, true
	}
	return "", false
}

type authHit struct {
	at   float64
	info AuthInfo
}

// AuthModeDetector = class AuthModeDetector。所有方法须持 jsrt 锁调用。
type AuthModeDetector struct {
	d             AuthDeps
	cache         map[string]authHit
	inflight      map[string]*jsrt.Promise[AuthInfo]
	known         map[string]AuthInfo
	knownOrder    []string
	onKnownChange func()
}

func NewAuthModeDetector(d AuthDeps) *AuthModeDetector {
	return &AuthModeDetector{d: d, cache: map[string]authHit{}, inflight: map[string]*jsrt.Promise[AuthInfo]{}, known: map[string]AuthInfo{}}
}

func (a *AuthModeDetector) envOf(id string) *util.Obj {
	if a.d.EnvFor != nil {
		if e := a.d.EnvFor(id); e != nil {
			return e
		}
	}
	if a.d.Env != nil {
		return a.d.Env
	}
	return ProcessEnv()
}

func (a *AuthModeDetector) cliEnv(id string) *util.Obj {
	if a.d.EnvFor != nil {
		if e := a.d.EnvFor(id); e != nil {
			return e
		}
	}
	if DefaultCliEnv != nil {
		return DefaultCliEnv()
	}
	return ProcessEnv()
}

func (a *AuthModeDetector) now() float64 {
	if a.d.Now != nil {
		return a.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (a *AuthModeDetector) home() string {
	if a.d.Home != "" {
		return a.d.Home
	}
	return Homedir()
}

func isAuthTool(id string) bool { return id == "claude" || id == "codex" || id == "grok" }

// Detect = detect（须持锁；Await）。
func (a *AuthModeDetector) Detect(id string) string {
	info, _ := jsrt.Await(a.DetectFull(id))
	return info.Mode
}

// DetectFull = detectFull。
func (a *AuthModeDetector) DetectFull(id string) *jsrt.Promise[AuthInfo] {
	if id == "nomi" || id == "dsh" {
		return jsrt.Resolved(AuthInfo{Mode: AuthAPI})
	}
	if !isAuthTool(id) {
		return jsrt.Resolved(AuthInfo{Mode: AuthUnknown})
	}
	if hit, ok := a.cache[id]; ok && a.now()-hit.at < authTTLMs {
		return jsrt.Resolved(hit.info)
	}
	if p, ok := a.inflight[id]; ok {
		return p
	}
	// Node：p = probe(id).then(写缓存 / setKnown).finally(删 inflight)；inflight.set 同步发生，
	// then 回调在微任务里跑（结算前 detectPassive 看不到缓存），probe 拒绝时 finally 照样删 inflight。
	probeP := jsrt.Async(func() (AuthInfo, error) { return a.probe(id), nil })
	p := jsrt.Async(func() (AuthInfo, error) {
		info, err := jsrt.Await(probeP)
		if err == nil {
			a.cache[id] = authHit{a.now(), info}
			if info.SignedOut {
				a.setKnown(id, nil)
			} else if info.FromCli {
				k := AuthInfo{Mode: info.Mode, FP: info.FP, Plan: info.Plan}
				a.setKnown(id, &k)
			}
		}
		delete(a.inflight, id)
		return info, err
	})
	if !p.Settled() {
		a.inflight[id] = p
	}
	return p
}

func (a *AuthModeDetector) SetOnKnownChange(fn func()) { a.onKnownChange = fn }

// KnownSnapshot = knownSnapshot（Map 插入顺序）。
func (a *AuthModeDetector) KnownSnapshot() *util.Obj {
	o := util.NewObj()
	for _, k := range a.knownOrder {
		o.Set(k, a.known[k].ToObj())
	}
	return o
}

// KnownIDs / Known：快照的有序视图。
func (a *AuthModeDetector) KnownIDs() []string               { return append([]string(nil), a.knownOrder...) }
func (a *AuthModeDetector) Known(id string) (AuthInfo, bool) { v, ok := a.known[id]; return v, ok }

func (a *AuthModeDetector) knownSet(id string, info AuthInfo) {
	if _, ok := a.known[id]; !ok {
		a.knownOrder = append(a.knownOrder, id)
	}
	a.known[id] = info
}

func (a *AuthModeDetector) knownDelete(id string) {
	delete(a.known, id)
	for i, k := range a.knownOrder {
		if k == id {
			a.knownOrder = append(a.knownOrder[:i:i], a.knownOrder[i+1:]...)
			break
		}
	}
}

// RestoreKnown = restoreKnown（ids 为 Object.entries 顺序）。
func (a *AuthModeDetector) RestoreKnown(ids []string, saved map[string]AuthInfo) {
	for _, id := range ids {
		a.knownSet(id, saved[id])
	}
}

// ForgetKnown = forgetKnown（"" = 全部）。
func (a *AuthModeDetector) ForgetKnown(id string) {
	if id != "" {
		a.setKnown(id, nil)
		return
	}
	for _, k := range a.KnownIDs() {
		a.setKnown(k, nil)
	}
}

func strpEq(x, y *string) bool {
	if x == nil || y == nil {
		return x == y
	}
	return *x == *y
}

func (a *AuthModeDetector) setKnown(id string, info *AuthInfo) {
	prev, had := a.known[id]
	if info != nil {
		if had && prev.Mode == info.Mode && strpEq(prev.FP, info.FP) && prev.Plan == info.Plan {
			return
		}
		a.knownSet(id, *info)
	} else if had {
		a.knownDelete(id)
	} else {
		return
	}
	if a.onKnownChange != nil {
		func() { defer func() { _ = recover() }(); a.onKnownChange() }()
	}
}

// Invalidate = invalidate（"" = 全部）。
func (a *AuthModeDetector) Invalidate(id string) {
	if id != "" {
		delete(a.cache, id)
	} else {
		a.cache = map[string]authHit{}
	}
}

// DetectPassive = detectPassive（绝不起进程）。
func (a *AuthModeDetector) DetectPassive(id string) AuthInfo {
	if id == "nomi" || id == "dsh" {
		return AuthInfo{Mode: AuthAPI}
	}
	if !isAuthTool(id) {
		return AuthInfo{Mode: AuthUnknown}
	}
	if id == "claude" {
		home, env := a.home(), a.envOf(id)
		if p := ClaudeOAuthPresent(home, env); p != nil && !*p && ClaudeAuthFromConfig(home, env) != AuthAPI {
			delete(a.cache, id)
			a.setKnown(id, nil)
			return AuthInfo{Mode: AuthUnknown, SignedOut: true}
		}
	}
	if hit, ok := a.cache[id]; ok {
		return hit.info
	}
	if pre := a.beforeCli(id); pre != nil {
		return *pre
	}
	if k, ok := a.known[id]; ok {
		return k
	}
	return a.afterCli(id, false)
}

func (a *AuthModeDetector) beforeCli(id string) *AuthInfo {
	home, env := a.home(), a.envOf(id)
	if id == "claude" && ClaudeAuthFromConfig(home, env) == AuthAPI {
		return &AuthInfo{Mode: AuthAPI}
	}
	if id == "grok" && HasManagedGrokConfiguration(home, env) {
		return &AuthInfo{Mode: AuthAPI}
	}
	if id == "grok" && !HasGrokLocalPresence(home, env) && !HasCustomGrokConfiguration(home, env) {
		return &AuthInfo{Mode: AuthUnknown}
	}
	return nil
}

func (a *AuthModeDetector) afterCli(id string, signedOut bool) AuthInfo {
	home, env := a.home(), a.envOf(id)
	var cfg string
	switch id {
	case "claude":
		cfg = ClaudeAuthFromConfig(home, env)
	case "codex":
		cfg = CodexAuthFromConfig(home, env)
	default:
		cfg = GrokAuthFromConfig(home, env)
	}
	if cfg != "" {
		return AuthInfo{Mode: cfg}
	}
	if signedOut {
		return AuthInfo{Mode: AuthUnknown, SignedOut: true}
	}
	if a.d.HasSubscriptionData != nil && a.d.HasSubscriptionData(id) {
		return AuthInfo{Mode: AuthSubscription}
	}
	return AuthInfo{Mode: AuthUnknown}
}

func (a *AuthModeDetector) probe(id string) AuthInfo {
	if pre := a.beforeCli(id); pre != nil {
		return *pre
	}
	text, ok := "", false
	func() {
		defer func() {
			if r := recover(); r != nil {
				text, ok = "", false // .catch(() => null)
			}
		}()
		switch {
		case id == "grok" && a.d.GrokRun != nil:
			text, ok = a.d.GrokRun()
		case id != "grok" && a.d.Run != nil:
			text, ok = a.d.Run(id)
		default:
			text, ok = runStatus(id, a.cliEnv(id))
		}
	}()
	has := ok && text != ""
	fromCli := ""
	if has {
		switch id {
		case "claude":
			fromCli = ParseClaudeAuthStatus(text)
		case "codex":
			fromCli = ParseCodexLoginStatus(text)
		default:
			fromCli = ParseGrokAuthStatus(text)
		}
	}
	if fromCli != "" && fromCli != AuthUnknown {
		out := AuthInfo{Mode: fromCli, FromCli: true}
		if id == "claude" && a.d.Salt != nil {
			ident := ParseClaudeIdentity(text, a.d.Salt())
			out.FP, out.Plan = ident.FP, ident.Plan
		}
		return out
	}
	signedOut := (id == "claude" || id == "codex") && has && IsDefinitelySignedOut(id, text)
	return a.afterCli(id, signedOut)
}

// ApplyAuthModes = applyAuthModes。
func ApplyAuthModes(entries []QuotaEntry, modes map[string]string, detected map[string]bool) []QuotaEntry {
	out := []QuotaEntry{}
	for _, e := range entries {
		auth := modes[e.ID]
		if auth == "" {
			auth = AuthUnknown
		}
		if e.ID == "nomi" {
			continue
		}
		if e.Status != "ok" && auth != AuthSubscription && !detected[e.ID] {
			continue
		}
		switch {
		case auth == AuthAPI:
			e.Status, e.Windows, e.Auth = "api", []QuotaWindow{}, auth
			out = append(out, e)
		case auth == AuthSubscription:
			e.Auth = auth
			out = append(out, e)
		case e.Status == "ok":
			e.Auth = auth
			out = append(out, e)
		}
	}
	return out
}
