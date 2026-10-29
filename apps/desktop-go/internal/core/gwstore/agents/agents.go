// Package agents = packages/core/src/gateway/agents/index.ts：第三方会话的进程级注入。
package agents

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/launch"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DefaultCtx / DefaultMaxOutput = modelMeta DEFAULT_CTX / DEFAULT_MAX_OUTPUT
const (
	DefaultCtx       = 128_000
	DefaultMaxOutput = 32_000
)

// ModelMeta = ModelMeta（nil 指针 = 字段缺失）
type ModelMeta struct {
	Label, Provider   *string
	Ctx, MaxOutput    *float64
	Reasoning, Vision *bool
}

// LaunchContext = LaunchContext；Models = ClientModels 对象（可为 nil）
type LaunchContext struct {
	URL, Token, Model string
	Models            *u.Obj
	Dir               string
	MetaOf            func(ref string) *ModelMeta
	Catalog           []string
	Placeholder       *string
	Home              string
	Platform          string // 测试注入；空 = 当前 Node platform
}

// AgentLaunch = AgentLaunch；Env 为有序对象（值均为 string）
type AgentLaunch struct {
	Env           *u.Obj
	Args          []string
	Strip         []string
	ModelInConfig *bool
}

// Obj：同 JS 字面量键序
func (a *AgentLaunch) Obj() *u.Obj {
	args := make([]any, len(a.Args))
	for i, s := range a.Args {
		args[i] = s
	}
	strip := make([]any, len(a.Strip))
	for i, s := range a.Strip {
		strip[i] = s
	}
	o := u.NewObj("env", a.Env, "args", args, "strip", strip)
	if a.ModelInConfig != nil {
		o.Set("modelInConfig", *a.ModelInConfig)
	}
	return o
}

// STRIP
var STRIP = map[string][]string{
	"claude": {
		"ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_PROFILE",
		"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_SUBAGENT_MODEL",
		"CLAUDE_CONFIG_DIR",
	},
	"codex":  {"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"},
	"gemini": {"GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"},
	"grok":   {"XAI_API_KEY", "GROK_API_KEY"},
	"dsh":    {},
}

var tiers = []string{"opus", "sonnet", "haiku", "fable"}

func numStr(f float64) string { return u.FormatNumber(f) }

func thinkingBudget(maxOutput float64) float64 { return math.Min(16_000, math.Floor(maxOutput/2)) }

func capabilities(m *ModelMeta) string {
	if m != nil && m.Reasoning != nil && *m.Reasoning {
		return "thinking,interleaved_thinking"
	}
	return "temperature"
}

func (c *LaunchContext) meta(ref string) *ModelMeta {
	if c.MetaOf == nil {
		return nil
	}
	return c.MetaOf(ref)
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

func modelStr(o *u.Obj, k string) (string, bool) {
	if o == nil {
		return "", false
	}
	s, ok := o.Get(k).(string)
	return s, ok
}

func claudeTier(c *LaunchContext, tier string) string {
	if c.Models != nil {
		if t, ok := c.Models.Get("tiers").(*u.Obj); ok {
			if s, ok := modelStr(t, tier); ok {
				return s
			}
		}
	}
	if tier == "haiku" {
		if s, ok := modelStr(c.Models, "small"); ok {
			return s
		}
	}
	return c.Model
}

func homeOr(h string) string {
	if h != "" {
		return h
	}
	return usage.Homedir()
}

func envTrim(k string) string {
	s, _ := usage.ProcessEnv().Get(k).(string)
	return u.JSTrim(s)
}

func prepareClaudeHome(c *LaunchContext) error {
	userDir := accounts.UserCliHome("claude", nil, homeOr(c.Home))
	if _, err := accounts.EnsureAccountHome("claude", c.Dir, userDir, c.platform()); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(c.Dir, "settings.local.json"))
	return nil
}

func claude(c *LaunchContext) (*AgentLaunch, error) {
	if err := prepareClaudeHome(c); err != nil {
		return nil, err
	}
	meta := c.meta(c.Model)
	ctx, maxOutput := ctxOf(meta), maxOutOf(meta)
	think := 0.0
	if meta != nil && meta.Reasoning != nil && *meta.Reasoning {
		think = thinkingBudget(maxOutput)
	}
	env := u.NewObj(
		"CLAUDE_CONFIG_DIR", c.Dir,
		"ANTHROPIC_BASE_URL", c.URL,
		"ANTHROPIC_AUTH_TOKEN", c.Token,
		"ANTHROPIC_SMALL_FAST_MODEL", claudeTier(c, "haiku"),
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS", numStr(ctx),
		"CLAUDE_CODE_MAX_OUTPUT_TOKENS", numStr(maxOutput),
		"MAX_THINKING_TOKENS", numStr(think),
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
		"CLAUDE_CODE_DISABLE_AGENT_VIEW", "1",
	)
	for _, tier := range tiers {
		ref := claudeTier(c, tier)
		m := c.meta(ref)
		key := "ANTHROPIC_DEFAULT_" + strings.ToUpper(tier) + "_MODEL"
		env.Set(key, ref)
		env.Set(key+"_SUPPORTED_CAPABILITIES", capabilities(m))
		if m != nil && m.Label != nil && *m.Label != "" {
			env.Set(key+"_NAME", *m.Label)
		}
		if m != nil && m.Provider != nil && *m.Provider != "" {
			env.Set(key+"_DESCRIPTION", "Nomi · "+*m.Provider)
		}
	}
	if s, ok := modelStr(c.Models, "subagent"); ok && s != "" {
		env.Set("CLAUDE_CODE_SUBAGENT_MODEL", s)
	}
	return &AgentLaunch{Env: env, Args: []string{}, Strip: STRIP["claude"]}, nil
}

// q = TOML 基本字符串
func q(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

func codexCatalog(c *LaunchContext) (string, error) {
	home := envTrim("CODEX_HOME")
	if home == "" {
		home = filepath.Join(homeOr(c.Home), ".codex")
	}
	raw, err := os.ReadFile(filepath.Join(home, "models_cache.json"))
	if err != nil {
		return "", nil
	}
	parsed, err := u.Parse(raw)
	if err != nil {
		return "", nil
	}
	cache, _ := parsed.(*u.Obj)
	if cache == nil {
		// JSON.parse 得到非对象：cache.models 读 null 会抛，被 catch 吞掉
		return "", nil
	}
	list, _ := cache.Get("models").([]any)
	if len(list) == 0 || !truthy(list[0]) {
		return "", nil
	}
	template, ok := list[0].(*u.Obj)
	if !ok {
		return "", nil
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
		} else if v := template.Get("input_modalities"); v != nil {
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
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return "", err
	}
	file := filepath.Join(c.Dir, "models.json")
	if err := os.WriteFile(file, []byte(u.Stringify(u.NewObj("models", models))), 0o600); err != nil {
		return "", err
	}
	return file, nil
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	}
	return true
}

func codex(c *LaunchContext) (*AgentLaunch, error) {
	ctx := ctxOf(c.meta(c.Model))
	catalog, err := codexCatalog(c)
	if err != nil {
		return nil, err
	}
	args := []string{
		"-c", `model_provider="nomi_gateway"`,
		"-c", fmt.Sprintf(`model_providers.nomi_gateway={ name="Nomi", base_url=%s, wire_api="responses", env_key="NOMI_GATEWAY_KEY" }`, q(c.URL+"/v1")),
		"-c", "model_context_window=" + numStr(ctx),
		"-c", "model_auto_compact_token_limit=" + numStr(math.Floor(ctx*0.8)),
	}
	if catalog != "" {
		args = append(args, "-c", "model_catalog_json="+q(catalog))
	}
	return &AgentLaunch{Env: u.NewObj("NOMI_GATEWAY_KEY", c.Token), Args: args, Strip: STRIP["codex"]}, nil
}

func bp(b bool) *bool { return &b }

func gemini(c *LaunchContext) (*AgentLaunch, error) {
	return &AgentLaunch{
		Env: u.NewObj(
			"GEMINI_CLI_AUTH_OVERRIDE", "gemini-api-key",
			"GOOGLE_GEMINI_BASE_URL", c.URL,
			"GEMINI_API_KEY", c.Token,
			"GEMINI_MODEL", c.Model,
		),
		Args: []string{}, Strip: STRIP["gemini"], ModelInConfig: bp(true),
	}, nil
}

const (
	dshMarkBegin = "# >>> nomi managed (dsh provider) >>>"
	dshMarkEnd   = "# <<< nomi managed (dsh provider) <<<"
	dshKeyEnv    = "NOMI_DSH_API_KEY"
)

// PatchDshYamlNew = patchDshYaml(null, patch)
func PatchDshYamlNew(api, baseURL, model string, contextWindow, maxTokens float64) string {
	yq := func(s string) string { return u.Stringify(s) }
	lines := []string{
		dshMarkBegin,
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      nomi:",
		"        api: " + yq(api),
		"        baseURL: " + yq(baseURL),
		"        apiKeyEnv: " + dshKeyEnv,
		"        models:",
		"          - id: " + yq(model),
	}
	if contextWindow != 0 && !math.IsNaN(contextWindow) {
		lines = append(lines, "            contextWindow: "+numStr(contextWindow))
	}
	if maxTokens != 0 && !math.IsNaN(maxTokens) {
		lines = append(lines, "            maxTokens: "+numStr(maxTokens))
	}
	lines = append(lines,
		"- id: agent-default-model",
		"  config:",
		"    provider: nomi",
		"    model: "+yq(model),
		dshMarkEnd,
	)
	return strings.Join(lines, "\n") + "\n"
}

func dsh(c *LaunchContext) (*AgentLaunch, error) {
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return nil, err
	}
	file := filepath.Join(c.Dir, "patch.yml")
	meta := c.meta(c.Model)
	body := PatchDshYamlNew("openai-responses", c.URL+"/v1", c.Model, ctxOf(meta), maxOutOf(meta))
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		return nil, err
	}
	return &AgentLaunch{
		Env: u.NewObj("NOMI_DSH_API_KEY", c.Token), Args: []string{"--patch", file},
		Strip: STRIP["dsh"], ModelInConfig: bp(true),
	}, nil
}

func grok(c *LaunchContext) (*AgentLaunch, error) {
	shared := envTrim("GROK_HOME")
	if shared == "" {
		shared = filepath.Join(homeOr(c.Home), ".grok")
	}
	if err := os.MkdirAll(filepath.Join(shared, "sessions"), 0o777); err != nil {
		return nil, err
	}
	problems, err := launch.EnsurePrivateHome(c.Dir, shared, ".*", []string{`^(config\.toml|auth\.json)$`, `\.lock$`}, c.platform())
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		parts := make([]string, len(problems))
		for i, p := range problems {
			parts[i] = p.Entry + ": " + p.Reason
		}
		fmt.Fprintln(os.Stderr, "[gateway/agents] grok private home softlink problems", strings.Join(parts, "; "))
	}
	ctx := ctxOf(c.meta(c.Model))
	model := c.Model
	if c.Placeholder != nil {
		model = *c.Placeholder
	}
	body := strings.Join([]string{
		"# Private config for a Nomi third-party session (does not affect ~/.grok)",
		"[model.nomi]",
		"model = " + q(model),
		"base_url = " + q(c.URL+"/v1"),
		`name = "Nomi"`,
		`env_key = "NOMI_GROK_API_KEY"`,
		`api_backend = "responses"`,
		"context_window = " + numStr(ctx),
		"max_retries = 1",
		"",
		"[models]",
		`default = "nomi"`,
		`session_summary = "nomi"`,
		`prompt_suggestion = "nomi"`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(c.Dir, "config.toml"), []byte(body), 0o600); err != nil {
		return nil, err
	}
	return &AgentLaunch{
		Env:  u.NewObj("GROK_HOME", c.Dir, "NOMI_GROK_API_KEY", c.Token, "NOMI_GROK_CONTEXT_WINDOW", numStr(ctx)),
		Args: []string{}, Strip: STRIP["grok"], ModelInConfig: bp(c.Placeholder == nil || *c.Placeholder == ""),
	}, nil
}

// AgentLaunchFor = agentLaunch(kind, c)；未知 kind 同 JS 抛 TypeError
func AgentLaunchFor(kind string, c *LaunchContext) (*AgentLaunch, error) {
	switch kind {
	case "claude":
		return claude(c)
	case "codex":
		return codex(c)
	case "gemini":
		return gemini(c)
	case "grok":
		return grok(c)
	case "dsh":
		return dsh(c)
	}
	return nil, fmt.Errorf("TypeError: AGENTS[kind] is not a function")
}

var leftoverRe = regexp.MustCompile(`^nomi-(?:gw|tab)-`)

// StripGatewayLeftovers = stripGatewayLeftovers（env 值为 string 或 undefined=nil）
func StripGatewayLeftovers(env *u.Obj, url string, tokens []string) *u.Obj {
	out := env.Clone()
	urls := map[string]bool{url: true, url + "/v1": true, url + "/": true}
	for _, k := range out.Keys() {
		v, _ := out.Get(k).(string)
		if v == "" {
			continue
		}
		drop := urls[v] || leftoverRe.MatchString(v)
		for _, t := range tokens {
			if t != "" && strings.Contains(v, t) {
				drop = true
			}
		}
		if drop {
			out.Delete(k)
		}
	}
	return out
}

func (c *LaunchContext) platform() string {
	if c.Platform != "" {
		return c.Platform
	}
	return usage.Platform()
}

// EnvGet：launch.env[k]
func (a *AgentLaunch) EnvGet(k string) (string, bool) {
	if a.Env == nil || !a.Env.Has(k) {
		return "", false
	}
	v, _ := a.Env.Get(k).(string)
	return v, true
}
