// Package gwagents ports packages/core/src/gateway/agents/index.ts (agentLaunch): per-CLI
// environment/argv/config injection for third-party sessions through the Nomi gateway.
package gwagents

import (
	"log"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/launch"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DEFAULT_CTX / DEFAULT_MAX_OUTPUT (gateway/modelMeta)
const (
	DefaultCtx       = 128000.0
	DefaultMaxOutput = 32000.0
)

// ModelMeta：可选字段用指针（undefined = nil）
type ModelMeta struct {
	Label, Provider   *string
	Ctx, MaxOutput    *float64
	Reasoning, Vision *bool
}

// Obj：JS 形状（键序 label, provider, ctx, maxOutput, reasoning, vision）
func (m *ModelMeta) Obj() *u.Obj {
	o := u.NewObj()
	if m.Label != nil {
		o.Set("label", *m.Label)
	}
	if m.Provider != nil {
		o.Set("provider", *m.Provider)
	}
	if m.Ctx != nil {
		o.Set("ctx", *m.Ctx)
	}
	if m.MaxOutput != nil {
		o.Set("maxOutput", *m.MaxOutput)
	}
	if m.Reasoning != nil {
		o.Set("reasoning", *m.Reasoning)
	}
	if m.Vision != nil {
		o.Set("vision", *m.Vision)
	}
	return o
}

// LaunchContext：Models 为 ClientModels 对象（main / tiers / small / subagent）
type LaunchContext struct {
	URL, Token, Model string
	Models            *u.Obj
	Dir               string
	MetaOf            func(ref string) *ModelMeta
	Catalog           []string
	Placeholder       *string
	Home              *string
	Platform          string // 测试注入；空 = runtime.GOOS 对应的 Node platform
}

// KV：有序环境变量
type KV struct{ K, V string }

type Launch struct {
	Env           []KV
	Args          []string
	Strip         []string
	ModelInConfig *bool
}

// EnvGet：launch.env[k]
func (l *Launch) EnvGet(k string) (string, bool) {
	for _, e := range l.Env {
		if e.K == k {
			return e.V, true
		}
	}
	return "", false
}

// Obj：JSON 形状 {env, args, strip, modelInConfig?}
func (l *Launch) Obj() *u.Obj {
	env := u.NewObj()
	for _, e := range l.Env {
		env.Set(e.K, e.V)
	}
	args := make([]any, len(l.Args))
	for i, a := range l.Args {
		args[i] = a
	}
	strip := make([]any, len(l.Strip))
	for i, a := range l.Strip {
		strip[i] = a
	}
	o := u.NewObj("env", env, "args", args, "strip", strip)
	if l.ModelInConfig != nil {
		o.Set("modelInConfig", *l.ModelInConfig)
	}
	return o
}

func set(env []KV, k, v string) []KV {
	for i := range env {
		if env[i].K == k {
			env[i].V = v
			return env
		}
	}
	return append(env, KV{k, v})
}

var STRIP = map[string][]string{
	"claude": {"ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_PROFILE",
		"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CONFIG_DIR"},
	"codex":  {"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"},
	"gemini": {"GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"},
	"grok":   {"XAI_API_KEY", "GROK_API_KEY"},
	"dsh":    {},
}

var tiers = []string{"opus", "sonnet", "haiku", "fable"}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func homeOf(c *LaunchContext) string {
	if c.Home != nil {
		return *c.Home
	}
	h, _ := os.UserHomeDir()
	return h
}

func (c *LaunchContext) meta(ref string) *ModelMeta {
	if c.MetaOf == nil {
		return nil
	}
	return c.MetaOf(ref)
}

func strField(o *u.Obj, k string) (string, bool) {
	if o == nil {
		return "", false
	}
	s, ok := o.Get(k).(string)
	return s, ok
}

func claudeTier(c *LaunchContext, tier string) string {
	if t, ok := c.Models.Get("tiers").(*u.Obj); ok {
		if v, ok := strField(t, tier); ok {
			return v
		}
	}
	if tier == "haiku" {
		if v, ok := strField(c.Models, "small"); ok {
			return v
		}
	}
	return c.Model
}

func ctxOf(m *ModelMeta) float64 {
	if m != nil && m.Ctx != nil {
		return *m.Ctx
	}
	return DefaultCtx
}

func maxOutOf(m *ModelMeta) float64 {
	if m != nil && m.MaxOutput != nil {
		return *m.MaxOutput
	}
	return DefaultMaxOutput
}

func num(x float64) string { return i18n.JSNumber(x) }

func capabilities(m *ModelMeta) string {
	if m != nil && m.Reasoning != nil && *m.Reasoning {
		return "thinking,interleaved_thinking"
	}
	return "temperature"
}

func prepareClaudeHome(c *LaunchContext) {
	userDir := usage.ClaudeConfigDir(homeOf(c), usage.ProcessEnv())
	EnsureAccountHome(c.Dir, userDir, platformOf(c))
	_ = os.RemoveAll(filepath.Join(c.Dir, "settings.local.json"))
}

func platformOf(c *LaunchContext) string {
	if c.Platform != "" {
		return c.Platform
	}
	return nodePlatform()
}

// claudeRoutingEnv / claudeUserKeys：cli/accounts/homes.ts
var claudeRoutingEnv = map[string]bool{
	"ANTHROPIC_BASE_URL": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true, "CLAUDE_CODE_OAUTH_TOKEN": true,
	"ANTHROPIC_PROFILE": true, "ANTHROPIC_MODEL": true, "ANTHROPIC_SMALL_FAST_MODEL": true, "ANTHROPIC_DEFAULT_OPUS_MODEL": true,
	"ANTHROPIC_DEFAULT_SONNET_MODEL": true, "ANTHROPIC_DEFAULT_HAIKU_MODEL": true, "CLAUDE_CODE_USE_BEDROCK": true,
	"CLAUDE_CODE_USE_VERTEX": true, "CLAUDE_CODE_USE_FOUNDRY": true,
}

var claudeUserKeys = []string{"mcpServers", "projects", "theme", "editorMode", "hasCompletedOnboarding", "autoUpdates", "verbose", "preferredNotifChannel"}

func readJSONObj(file string) *u.Obj {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	v, err := u.Parse(b)
	if err != nil {
		return nil
	}
	o, _ := v.(*u.Obj)
	return o
}

// EnsureAccountHome：ensureAccountHome('claude', ...)（共享软链 + 生成 settings.json / .claude.json）
func EnsureAccountHome(accountDir, userDir, platform string) []launch.LinkProblem {
	problems, _ := launch.EnsureSharedHome(accountDir, userDir, claude.Accounts.Shared, platform)
	syncClaudeFiles(accountDir, userDir)
	return problems
}

func userClaudeJSON(userDir string) string {
	inside := filepath.Join(userDir, ".claude.json")
	if _, err := os.Stat(inside); err == nil {
		return inside
	}
	return filepath.Join(filepath.Dir(userDir), ".claude.json")
}

func syncClaudeFiles(accountDir, userDir string) {
	settings := readJSONObj(filepath.Join(userDir, "settings.json"))
	if settings == nil {
		settings = u.NewObj()
	}
	settings = settings.Clone()
	settings.Delete("apiKeyHelper")
	if env, ok := settings.Get("env").(*u.Obj); ok {
		next := u.NewObj()
		for _, k := range env.Keys() {
			if !claudeRoutingEnv[k] {
				next.Set(k, env.Get(k))
			}
		}
		settings.Set("env", next)
	} else if arr, ok := settings.Get("env").([]any); ok {
		// Object.entries(array)：下标作键
		next := u.NewObj()
		for i, v := range arr {
			next.Set(num(float64(i)), v)
		}
		settings.Set("env", next)
	}
	_ = utils.WritePrivateFileAtomic(filepath.Join(accountDir, "settings.json"), []byte(u.StringifyIndent(settings, "  ")))
	user := readJSONObj(userClaudeJSON(userDir))
	if user == nil {
		user = u.NewObj()
	}
	mineFile := filepath.Join(accountDir, ".claude.json")
	next := readJSONObj(mineFile)
	if next == nil {
		next = u.NewObj()
	}
	for _, k := range claudeUserKeys {
		if v, ok := user.Lookup(k); ok {
			next.Set(k, v)
		}
	}
	_ = utils.WritePrivateFileAtomic(mineFile, []byte(u.StringifyIndent(next, "  ")))
}

func claudeLaunch(c *LaunchContext) *Launch {
	prepareClaudeHome(c)
	meta := c.meta(c.Model)
	ctx, maxOut := ctxOf(meta), maxOutOf(meta)
	think := 0.0
	if meta != nil && meta.Reasoning != nil && *meta.Reasoning {
		think = math.Min(16000, math.Floor(maxOut/2))
	}
	env := []KV{
		{"CLAUDE_CONFIG_DIR", c.Dir}, {"ANTHROPIC_BASE_URL", c.URL}, {"ANTHROPIC_AUTH_TOKEN", c.Token},
		{"ANTHROPIC_SMALL_FAST_MODEL", claudeTier(c, "haiku")},
		{"CLAUDE_CODE_MAX_CONTEXT_TOKENS", num(ctx)}, {"CLAUDE_CODE_MAX_OUTPUT_TOKENS", num(maxOut)},
		{"MAX_THINKING_TOKENS", num(think)},
		{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"}, {"CLAUDE_CODE_DISABLE_AGENT_VIEW", "1"},
	}
	for _, tier := range tiers {
		ref := claudeTier(c, tier)
		m := c.meta(ref)
		key := "ANTHROPIC_DEFAULT_" + strings.ToUpper(tier) + "_MODEL"
		env = set(env, key, ref)
		env = set(env, key+"_SUPPORTED_CAPABILITIES", capabilities(m))
		if m != nil && m.Label != nil && *m.Label != "" {
			env = set(env, key+"_NAME", *m.Label)
		}
		if m != nil && m.Provider != nil && *m.Provider != "" {
			env = set(env, key+"_DESCRIPTION", "Nomi · "+*m.Provider)
		}
	}
	if s, ok := strField(c.Models, "subagent"); ok && s != "" {
		env = set(env, "CLAUDE_CODE_SUBAGENT_MODEL", s)
	}
	return &Launch{Env: env, Args: []string{}, Strip: STRIP["claude"]}
}

// Q：q(s)（TOML/argv 字符串字面量）
func Q(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

func envTrim(k string) string { return u.JSTrim(os.Getenv(k)) }

func codexCatalog(c *LaunchContext) (string, bool) {
	home := envTrim("CODEX_HOME")
	if home == "" {
		home = filepath.Join(homeOf(c), ".codex")
	}
	cache := readJSONObj(filepath.Join(home, "models_cache.json"))
	if cache == nil {
		return "", false
	}
	ms, _ := cache.Get("models").([]any)
	if len(ms) == 0 || ms[0] == nil || ms[0] == false {
		return "", false
	}
	template, ok := ms[0].(*u.Obj)
	if !ok {
		return "", false // 非对象模板：spread 结果不同，Node 侧也视为异常数据
	}
	refs := []string{}
	seen := map[string]bool{}
	for _, r := range append([]string{c.Model}, c.Catalog...) {
		if !seen[r] {
			seen[r] = true
			refs = append(refs, r)
		}
	}
	models := []any{}
	for i, ref := range refs {
		m := c.meta(ref)
		ctx := ctxOf(m)
		o := template.Clone()
		o.Set("slug", ref)
		disp := ref
		if m != nil && m.Label != nil && *m.Label != "" {
			disp = *m.Label
			if m.Provider != nil && *m.Provider != "" {
				disp += " · " + *m.Provider
			}
		}
		o.Set("display_name", disp)
		desc := "Nomi"
		if m != nil && m.Provider != nil && *m.Provider != "" {
			desc = "Nomi · " + *m.Provider
		}
		o.Set("description", desc)
		o.Set("context_window", ctx)
		o.Set("max_context_window", ctx)
		if m != nil && m.Vision != nil && !*m.Vision {
			o.Set("input_modalities", []any{"text"})
		} else if v, ok := template.Lookup("input_modalities"); ok && v != nil {
			o.Set("input_modalities", v)
		} else {
			o.Set("input_modalities", []any{"text"})
		}
		if m != nil && m.Reasoning != nil && !*m.Reasoning {
			o.Set("supported_reasoning_levels", []any{})
			o.Set("default_reasoning_level", nil)
		}
		o.Set("priority", float64(i))
		o.Set("visibility", "list")
		o.Set("upgrade", nil)
		o.Set("availability_nux", nil)
		models = append(models, o)
	}
	_ = os.MkdirAll(c.Dir, 0o700)
	file := filepath.Join(c.Dir, "models.json")
	_ = writeFileMode(file, u.Stringify(u.NewObj("models", models)), 0o600)
	return file, true
}

// writeFileMode：fs.writeFileSync(file, data, {mode})（mode 只在新建时生效）
func writeFileMode(file, data string, mode os.FileMode) error {
	return os.WriteFile(file, []byte(data), mode)
}

func codexLaunch(c *LaunchContext) *Launch {
	ctx := ctxOf(c.meta(c.Model))
	args := []string{
		"-c", `model_provider="nomi_gateway"`,
		"-c", `model_providers.nomi_gateway={ name="Nomi", base_url=` + Q(c.URL+"/v1") + `, wire_api="responses", env_key="NOMI_GATEWAY_KEY" }`,
		"-c", "model_context_window=" + num(ctx),
		"-c", "model_auto_compact_token_limit=" + num(math.Floor(ctx*0.8)),
	}
	if f, ok := codexCatalog(c); ok {
		args = append(args, "-c", "model_catalog_json="+Q(f))
	}
	return &Launch{Env: []KV{{"NOMI_GATEWAY_KEY", c.Token}}, Args: args, Strip: STRIP["codex"]}
}

var tru, fal = true, false

func geminiLaunch(c *LaunchContext) *Launch {
	return &Launch{Env: []KV{{"GEMINI_CLI_AUTH_OVERRIDE", "gemini-api-key"}, {"GOOGLE_GEMINI_BASE_URL", c.URL},
		{"GEMINI_API_KEY", c.Token}, {"GEMINI_MODEL", c.Model}}, Args: []string{}, Strip: STRIP["gemini"], ModelInConfig: &tru}
}

const (
	DshMarkBegin = "# >>> nomi managed (dsh provider) >>>"
	DshMarkEnd   = "# <<< nomi managed (dsh provider) <<<"
	DshKeyEnv    = "NOMI_DSH_API_KEY"
)

type DshPatch struct {
	API, BaseURL, Model      string
	ContextWindow, MaxTokens float64
}

// PatchDshYaml：cli/configPatch.ts patchDshYaml
func PatchDshYaml(raw *string, patch *DshPatch) string {
	src := ""
	if raw != nil {
		src = *raw
	}
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	kept := []string{}
	in := false
	for _, l := range lines {
		if u.JSTrim(l) == DshMarkBegin {
			in = true
			continue
		}
		if in {
			if u.JSTrim(l) == DshMarkEnd {
				in = false
			}
			continue
		}
		kept = append(kept, l)
	}
	for len(kept) > 0 && u.JSTrim(kept[len(kept)-1]) == "" {
		kept = kept[:len(kept)-1]
	}
	if patch != nil {
		if len(kept) == 1 && u.JSTrim(kept[0]) == "[]" {
			kept = kept[:0]
		}
		if len(kept) > 0 {
			kept = append(kept, "")
		}
		yq := func(s string) string { return u.Stringify(s) }
		kept = append(kept, DshMarkBegin, "- id: llm-pi-ai", "  config:", "    providers:", "      nomi:",
			"        api: "+yq(patch.API), "        baseURL: "+yq(patch.BaseURL), "        apiKeyEnv: "+DshKeyEnv,
			"        models:", "          - id: "+yq(patch.Model))
		if patch.ContextWindow != 0 && !math.IsNaN(patch.ContextWindow) {
			kept = append(kept, "            contextWindow: "+num(patch.ContextWindow))
		}
		if patch.MaxTokens != 0 && !math.IsNaN(patch.MaxTokens) {
			kept = append(kept, "            maxTokens: "+num(patch.MaxTokens))
		}
		kept = append(kept, "- id: agent-default-model", "  config:", "    provider: nomi", "    model: "+yq(patch.Model), DshMarkEnd)
	}
	if len(kept) > 0 {
		return strings.Join(kept, "\n") + "\n"
	}
	return "[]\n"
}

func dshLaunch(c *LaunchContext) *Launch {
	_ = os.MkdirAll(c.Dir, 0o700)
	file := filepath.Join(c.Dir, "patch.yml")
	m := c.meta(c.Model)
	_ = writeFileMode(file, PatchDshYaml(nil, &DshPatch{API: "openai-responses", BaseURL: c.URL + "/v1", Model: c.Model,
		ContextWindow: ctxOf(m), MaxTokens: maxOutOf(m)}), 0o600)
	return &Launch{Env: []KV{{"NOMI_DSH_API_KEY", c.Token}}, Args: []string{"--patch", file}, Strip: STRIP["dsh"], ModelInConfig: &tru}
}

func grokLaunch(c *LaunchContext) *Launch {
	shared := envTrim("GROK_HOME")
	if shared == "" {
		shared = filepath.Join(homeOf(c), ".grok")
	}
	_ = os.MkdirAll(filepath.Join(shared, "sessions"), 0o777)
	problems, _ := launch.EnsurePrivateHome(c.Dir, shared, ".*", []string{`^(config\.toml|auth\.json)$`, `\.lock$`}, platformOf(c))
	if len(problems) > 0 {
		parts := []string{}
		for _, p := range problems {
			parts = append(parts, p.Entry+": "+p.Reason)
		}
		log.Println("[gateway/agents] grok private home softlink problems", strings.Join(parts, "; "))
	}
	ctx := ctxOf(c.meta(c.Model))
	model := c.Model
	if c.Placeholder != nil {
		model = *c.Placeholder
	}
	_ = writeFileMode(filepath.Join(c.Dir, "config.toml"), strings.Join([]string{
		"# Private config for a Nomi third-party session (does not affect ~/.grok)",
		"[model.nomi]", "model = " + Q(model), "base_url = " + Q(c.URL+"/v1"), `name = "Nomi"`,
		`env_key = "NOMI_GROK_API_KEY"`, `api_backend = "responses"`, "context_window = " + num(ctx), "max_retries = 1", "",
		"[models]", `default = "nomi"`, `session_summary = "nomi"`, `prompt_suggestion = "nomi"`, "",
	}, "\n"), 0o600)
	mic := c.Placeholder == nil
	return &Launch{Env: []KV{{"GROK_HOME", c.Dir}, {"NOMI_GROK_API_KEY", c.Token}, {"NOMI_GROK_CONTEXT_WINDOW", num(ctx)}},
		Args: []string{}, Strip: STRIP["grok"], ModelInConfig: &mic}
}

// AgentLaunch = agentLaunch(kind, c)
func AgentLaunch(kind string, c *LaunchContext) *Launch {
	if c.Models == nil {
		c.Models = u.NewObj()
	}
	switch kind {
	case "claude":
		return claudeLaunch(c)
	case "codex":
		return codexLaunch(c)
	case "gemini":
		return geminiLaunch(c)
	case "grok":
		return grokLaunch(c)
	case "dsh":
		return dshLaunch(c)
	}
	return nil
}

var _ = fal
