package accounts

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/launch"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// accountCap：插件的账号能力（没有的 nil）
func accountCap(kind string) *clisdk.AccountCapability {
	if m := builtin.Impl(kind); m != nil {
		return m.Accounts
	}
	return nil
}

func capOf(kind string, field string) *clisdk.AccountCapability {
	c := accountCap(kind)
	if c == nil {
		panic(typeErr("Cannot read properties of undefined (reading '" + field + "')"))
	}
	return c
}

// HomeEnv = HOME_ENV[kind] ("" for unknown kinds = undefined).
func HomeEnv(kind string) string {
	if c := accountCap(kind); c != nil {
		return c.HomeEnv
	}
	return ""
}

// OfficialStrip = OFFICIAL_STRIP[kind].
func OfficialStrip(kind string) []string { return capOf(kind, "filter").Strip }

// LoginArgs = loginArgs(kind).
func LoginArgs(kind string) []string { return capOf(kind, "loginArgs").LoginArgs }

// LogoutArgs = logoutArgs(kind) (nil = null).
func LogoutArgs(kind string) []string { return capOf(kind, "logoutArgs").LogoutArgs }

var claudeRoutingEnv = map[string]bool{
	"ANTHROPIC_BASE_URL": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true,
	"CLAUDE_CODE_OAUTH_TOKEN": true, "ANTHROPIC_PROFILE": true, "ANTHROPIC_MODEL": true,
	"ANTHROPIC_SMALL_FAST_MODEL": true, "ANTHROPIC_DEFAULT_OPUS_MODEL": true,
	"ANTHROPIC_DEFAULT_SONNET_MODEL": true, "ANTHROPIC_DEFAULT_HAIKU_MODEL": true,
	"CLAUDE_CODE_USE_BEDROCK": true, "CLAUDE_CODE_USE_VERTEX": true, "CLAUDE_CODE_USE_FOUNDRY": true,
}

var claudeUserKeys = []string{
	"mcpServers", "projects", "theme", "editorMode", "hasCompletedOnboarding",
	"autoUpdates", "verbose", "preferredNotifChannel",
}

// UserCliHome = userCliHome (home "" = os.homedir(); env nil = process.env).
func UserCliHome(kind string, env *util.Obj, home string) string {
	if env == nil {
		env = usage.ProcessEnv()
	}
	if home == "" {
		home = usage.Homedir()
	}
	switch kind {
	case "claude":
		return usage.ClaudeConfigDir(home, env)
	case "codex":
		return usage.CodexHomeDir(home, env)
	case "grok":
		return usage.GrokHomeDir(home, env)
	case "gemini":
		if s, ok := env.Get("GEMINI_CLI_HOME").(string); ok {
			if t := util.JSTrim(s); t != "" {
				return t
			}
		}
		return home
	}
	return ""
}

// CanonicalDir = canonicalDir.
func CanonicalDir(p string) string { return launch.CanonicalDir(p) }

// HomeProblem = LinkProblem.
type HomeProblem = launch.LinkProblem

// EnsureAccountHome = ensureAccountHome (errors = throws).
func EnsureAccountHome(kind, accountDir, userDir, platform string) ([]HomeProblem, error) {
	c := accountCap(kind)
	if c == nil {
		return nil, typeErr("Cannot read properties of undefined (reading 'shared')")
	}
	if platform == "" {
		platform = usage.Platform()
	}
	problems, err := launch.EnsureSharedHome(accountDir, userDir, c.Shared, platform)
	if err != nil {
		return nil, err
	}
	if kind == "claude" {
		if err := syncClaudeFiles(accountDir, userDir); err != nil {
			return nil, err
		}
	}
	if kind == "codex" {
		problems = append(problems, LinkCodexConfigRefs(accountDir, userDir, platform)...)
	}
	if problems == nil {
		problems = []HomeProblem{}
	}
	return problems, nil
}

// parseJSON = JSON.parse (V8 error text).
func parseJSON(src string) (any, error) {
	v, err := util.ParseString(src)
	if err == nil {
		return v, nil
	}
	if _, e := charcontract.ParseJSON(src); e != nil {
		return nil, jsonSyntax(e.Error())
	}
	return nil, jsonSyntax(err.Error())
}

func jsonSyntax(msg string) error { return jsThrow("SyntaxError", msg) }

func readJSONObj(file string) *util.Obj {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	v, err := parseJSON(string(b))
	if err != nil {
		return nil
	}
	return rec(v)
}

func userClaudeJSON(userDir string) string {
	inside := filepath.Join(userDir, ".claude.json")
	if usage.ExistsSync(inside) {
		return inside
	}
	return filepath.Join(filepath.Dir(userDir), ".claude.json")
}

func syncClaudeFiles(accountDir, userDir string) error {
	userSettings := readJSONObj(filepath.Join(userDir, "settings.json"))
	settings := userSettings.Clone()
	settings.Delete("apiKeyHelper")
	if ev, ok := settings.Lookup("env"); ok && truthy(ev) {
		var entries [][2]any
		switch x := ev.(type) {
		case *util.Obj:
			for _, k := range x.Keys() {
				v, _ := x.Lookup(k)
				entries = append(entries, [2]any{k, v})
			}
		case []any:
			for i, v := range x {
				entries = append(entries, [2]any{util.JSString(float64(i)), v})
			}
		default:
			entries = nil
		}
		switch ev.(type) {
		case *util.Obj, []any:
			env := util.NewObj()
			for _, e := range entries {
				if !claudeRoutingEnv[e[0].(string)] {
					env.Set(e[0].(string), e[1])
				}
			}
			settings.Set("env", env)
		}
	}
	if err := writePrivate(filepath.Join(accountDir, "settings.json"), util.StringifyIndent(settings, "  ")); err != nil {
		return err
	}
	user := readJSONObj(userClaudeJSON(userDir))
	mineFile := filepath.Join(accountDir, ".claude.json")
	next := readJSONObj(mineFile).Clone()
	for _, k := range claudeUserKeys {
		if v, ok := user.Lookup(k); ok && !isUndef(v) {
			next.Set(k, v)
		}
	}
	return writePrivate(mineFile, util.StringifyIndent(next, "  "))
}

func writePrivate(file, data string) error {
	return utils.WritePrivateFileAtomicNode(file, []byte(data))
}

// sanitizeID = id.replace(/[^\w-]/g, '_') per UTF-16 code unit.
func sanitizeID(id string) string {
	out := make([]byte, 0, len(id))
	for _, r := range id {
		switch {
		case r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			out = append(out, byte(r))
		case r >= 0x10000:
			out = append(out, '_', '_')
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}

// AccountDirFor = accountDirFor.
func AccountDirFor(root, kind, id string) string {
	return CanonicalDir(filepath.Join(root, "homes", kind, sanitizeID(id)))
}

// OfficialAccountEnv = officialAccountEnv (accountDir nil = null).
func OfficialAccountEnv(kind string, env *util.Obj, accountDir *string) *util.Obj {
	out := env.Clone()
	for _, k := range OfficialStrip(kind) {
		out.Delete(k)
	}
	he := HomeEnv(kind)
	if accountDir != nil && *accountDir != "" {
		out.Set(he, *accountDir)
		if kind == "claude" {
			out.Set("CLAUDE_CODE_DISABLE_AGENT_VIEW", "1")
		}
	} else if v := env.Get(he); truthy(v) {
		out.Set(he, v)
	}
	return out
}

// OfficialAccountArgs = officialAccountArgs.
func OfficialAccountArgs(kind string, accountDir *string) []string {
	if accountDir == nil || *accountDir == "" {
		return []string{}
	}
	return append([]string{}, capOf(kind, "accountArgs").AccountArgs...)
}

// codexPathKey：config.toml 里指向文件的键（model_catalog_json、model_instructions_file 等）的后缀
var codexPathKey = regexp.MustCompile(`(?:_file|_json|_path|_dir|_toml|_md)$`)

var codexAssignRe = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$`)
var schemeOrTildeRe = regexp.MustCompile(`^~|^[A-Za-z][A-Za-z0-9+.-]*:`)

// codexPrivate：无论 config.toml 怎么写都不链进账号目录的条目（凭据与账号自己的状态，S7）
var codexPrivate = map[string]bool{"auth.json": true, ".credentials.json": true, "log": true, "tmp": true, ".tmp": true}

// LinkCodexConfigRefs = linkCodexConfigRefs：config.toml 共享给账号目录，但其中的相对路径按 CODEX_HOME 解析
// （如 cc-switch 的 model_catalog_json = "cc-switch-model-catalog.json"）；账号目录里缺了 Codex 启动即报
// 「Error loading configuration: No such file or directory」。把引用到、用户目录里存在的相对路径（取第一段）也软链进来。
func LinkCodexConfigRefs(accountDir, userDir, platform string) []HomeProblem {
	b, err := os.ReadFile(filepath.Join(userDir, "config.toml"))
	if err != nil {
		return nil
	}
	shared := map[string]bool{}
	for _, e := range codex.Accounts.Shared {
		shared[e.Name] = true
	}
	seen := map[string]bool{}
	var problems []HomeProblem
	for _, line := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		m := codexAssignRe.FindStringSubmatch(line)
		if m == nil || !codexPathKey.MatchString(m[1]) {
			continue
		}
		value := m[2]
		if value == "" {
			value = m[3]
		}
		value = strings.TrimSpace(value)
		if value == "" || filepath.IsAbs(value) || schemeOrTildeRe.MatchString(value) {
			continue
		}
		first := strings.FieldsFunc(value, func(r rune) bool { return r == '/' || r == '\\' })
		if len(first) == 0 || value[0] == '/' || value[0] == '\\' {
			continue
		}
		name := first[0]
		if name == "." || name == ".." || codexPrivate[name] || shared[name] || seen[name] {
			continue
		}
		seen[name] = true
		target := filepath.Join(userDir, name)
		st, err := os.Stat(target)
		if err != nil {
			continue
		}
		if reason := launch.LinkShared(target, filepath.Join(accountDir, name), st.IsDir(), platform); reason != "" {
			problems = append(problems, HomeProblem{Entry: name, Reason: reason})
		}
	}
	return problems
}
