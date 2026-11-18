// Package delegate：Nomi 委派 agent（core / worktree / DelegateService）。
// 选谁、子任务档位、任务说明、汇报解析、worktree 隔离与 DelegateService。
//
// 数据形状固定：档位 / 设置 / 结果都是有序 *util.Obj（键顺序固定），
// 落盘与工具结果直接序列化，测试（testdata/b7s2-delegate.json）逐字比对。
package delegate

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DelegateClis：可以委派的内置 agent
var DelegateClis = builtin.Ordered

// DelegateKinds：任务类型（设置里按类型配默认 agent）
var DelegateKinds = []string{"coding", "prd", "review", "research"}

// RoutableTaskKinds：支持配置成本/来源路由的任务类型
var RoutableTaskKinds = []string{"coding", "review", "research", "prd", "scheduled", "complex", "simple"}

var validRunnerSources = []string{"local", "official", "thirdParty"}
var validCostTiers = []string{"high", "medium", "low"}
var validEfforts = []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

// ResolvedRunner：一次委派/任务路由的解析结果（空字段代表未显式覆盖，沿用全局默认）
type ResolvedRunner struct {
	Cli             string
	By              string
	PresetID        string
	Source          string
	AccountID       string
	Model           string
	ReasoningEffort string
}

// BuiltinAgentProfiles：内置档位（每次返回新对象）
func BuiltinAgentProfiles() []*util.Obj {
	return []*util.Obj{
		util.NewObj("id", "default", "label", "默认（沿用 CLI）"),
		util.NewObj("id", "cheap", "label", "便宜模型"),
		util.NewObj("id", "local", "label", "本地优先", "preferLocal", true),
	}
}

// DefaultDelegateSettings：{ enabled: true, defaults: {}, defaultProfileId: 'default' }
func DefaultDelegateSettings() *util.Obj {
	return util.NewObj("enabled", true, "defaults", util.NewObj(), "defaultProfileId", "default")
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func IsDelegateCli(v any) bool  { s, ok := v.(string); return ok && contains(DelegateClis, s) }
func IsDelegateKind(v any) bool { s, ok := v.(string); return ok && contains(DelegateKinds, s) }

var profileIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

func trim(s string) string { return util.JSTrim(s) }
func slice(s string, n int) string {
	return util.UTF16Slice0(s, n)
}

func strField(r *util.Obj, k string) (string, bool) {
	s, ok := r.Get(k).(string)
	return s, ok
}

func sanitizeProfile(raw any) *util.Obj {
	r, ok := raw.(*util.Obj)
	if !ok || r == nil {
		return nil
	}
	id := ""
	if s, ok := strField(r, "id"); ok {
		id = slice(trim(s), 64)
	}
	if id == "" || !profileIDRe.MatchString(id) {
		return nil
	}
	label := id
	if s, ok := strField(r, "label"); ok && trim(s) != "" {
		label = slice(trim(s), 80)
	}
	model := ""
	if s, ok := strField(r, "model"); ok && trim(s) != "" {
		model = slice(trim(s), 128)
	}
	out := util.NewObj("id", id, "label", label)
	if model != "" {
		out.Set("model", model)
	}
	if r.Has("reasoningEffort") && r.Get("reasoningEffort") == nil {
		out.Set("reasoningEffort", nil)
	} else if s, ok := strField(r, "reasoningEffort"); ok && trim(s) != "" {
		out.Set("reasoningEffort", slice(trim(s), 32))
	}
	if r.Get("preferLocal") == true {
		out.Set("preferLocal", true)
	}
	return out
}

func toList(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []*util.Obj:
		out := make([]any, len(a))
		for i, x := range a {
			out[i] = x
		}
		return out
	}
	return nil
}

// MergeAgentProfiles：内置 + 用户档位按 id 合并（用户可覆盖 label/model）。Map 语义：保持首次插入位置。
func MergeAgentProfiles(user any) []*util.Obj {
	var order []string
	m := map[string]*util.Obj{}
	for _, p := range BuiltinAgentProfiles() {
		order = append(order, util.Str(p.Get("id")))
		m[util.Str(p.Get("id"))] = p
	}
	for _, raw := range toList(user) {
		p := sanitizeProfile(raw)
		if p == nil {
			continue
		}
		id := util.Str(p.Get("id"))
		prev := m[id]
		label := util.Str(p.Get("label"))
		if label == "" && prev != nil {
			label = util.Str(prev.Get("label"))
		}
		if label == "" {
			label = id
		}
		n := util.NewObj("id", id, "label", label)
		if p.Has("model") {
			n.Set("model", p.Get("model"))
		} else if prev != nil && util.Str(prev.Get("model")) != "" {
			n.Set("model", prev.Get("model"))
		}
		if p.Has("reasoningEffort") {
			n.Set("reasoningEffort", p.Get("reasoningEffort"))
		} else if prev != nil && prev.Has("reasoningEffort") {
			n.Set("reasoningEffort", prev.Get("reasoningEffort"))
		}
		if p.Get("preferLocal") == true || (prev != nil && prev.Get("preferLocal") == true) {
			n.Set("preferLocal", true)
		}
		if _, ok := m[id]; !ok {
			order = append(order, id)
		}
		m[id] = n
	}
	out := make([]*util.Obj, 0, len(order))
	for _, id := range order {
		out = append(out, m[id])
	}
	return out
}

// SanitizeDelegateSettings：任意 JSON → DelegateSettings（有序对象）
func SanitizeDelegateSettings(raw any) *util.Obj {
	r, _ := raw.(*util.Obj)
	if r == nil {
		r = util.NewObj()
	}
	defaults := util.NewObj()
	if d, ok := r.Get("defaults").(*util.Obj); ok && d != nil {
		for _, k := range DelegateKinds {
			if v := d.Get(k); IsDelegateCli(v) {
				defaults.Set(k, v)
			}
		}
	}
	var profiles []*util.Obj
	isArr := false
	if a, ok := r.Get("profiles").([]any); ok {
		isArr = true
		profiles = []*util.Obj{}
		for _, x := range a {
			if p := sanitizeProfile(x); p != nil {
				profiles = append(profiles, p)
			}
		}
	}
	merged := MergeAgentProfiles(profiles)
	dpid := "default"
	if s, ok := strField(r, "defaultProfileId"); ok && trim(s) != "" {
		dpid = slice(trim(s), 64)
	}
	cheap := ""
	if s, ok := strField(r, "cheapModel"); ok && trim(s) != "" {
		cheap = slice(trim(s), 128)
	}
	found := false
	for _, p := range merged {
		if p.Get("id") == dpid {
			found = true
		}
	}
	if !found {
		dpid = "default"
	}
	out := util.NewObj("enabled", r.Get("enabled") != false, "defaults", defaults, "defaultProfileId", dpid)
	if isArr && len(profiles) > 0 {
		ps := make([]any, len(profiles))
		for i, p := range profiles {
			ps[i] = p
		}
		out.Set("profiles", ps)
	}
	if cheap != "" {
		out.Set("cheapModel", cheap)
	}
	if r.Has("autoComplexity") {
		if b, ok := r.Get("autoComplexity").(bool); ok {
			out.Set("autoComplexity", b)
		}
	}
	if r.Has("presets") {
		if rawList := toList(r.Get("presets")); rawList != nil {
			clean := []any{}
			seen := map[string]bool{}
			for _, x := range rawList {
				if p := sanitizePreset(x); p != nil {
					pid := util.Str(p.Get("id"))
					if !seen[pid] {
						seen[pid] = true
						clean = append(clean, p)
					}
				}
			}
			out.Set("presets", clean)
		}
	}
	if r.Has("routes") {
		if rm, ok := r.Get("routes").(*util.Obj); ok && rm != nil {
			cleanRoutes := util.NewObj()
			for _, k := range RoutableTaskKinds {
				if rt := sanitizeRouteTarget(rm.Get(k)); rt != nil {
					cleanRoutes.Set(k, rt)
				}
			}
			out.Set("routes", cleanRoutes)
		}
	}
	return out
}

func normalizeRunnerSourceForCli(cli, src string) string {
	if !builtin.WithAccounts(cli) {
		return "thirdParty"
	}
	if contains(validRunnerSources, src) {
		return src
	}
	return "official"
}

func sanitizePreset(raw any) *util.Obj {
	r, ok := raw.(*util.Obj)
	if !ok || r == nil {
		return nil
	}
	id := ""
	if s, ok := strField(r, "id"); ok {
		id = slice(trim(s), 64)
	}
	if id == "" || !profileIDRe.MatchString(id) {
		return nil
	}
	label := ""
	if s, ok := strField(r, "label"); ok {
		label = slice(trim(s), 80)
	}
	if label == "" {
		label = id
	}
	cli := ResolveDelegateCli(r.Get("cli"))
	if cli == "" || !IsDelegateCli(cli) {
		return nil
	}
	src := normalizeRunnerSourceForCli(cli, trim(util.Str(r.Get("source"))))
	out := util.NewObj("id", id, "label", label, "cli", cli, "source", src)
	if src == "official" {
		if acc, ok := strField(r, "accountId"); ok {
			acc = slice(trim(acc), 128)
			if acc != "" && !strings.HasPrefix(acc, "local-") {
				out.Set("accountId", acc)
			}
		}
	}
	if m, ok := strField(r, "model"); ok && trim(m) != "" {
		out.Set("model", slice(trim(m), 128))
	}
	if e, ok := strField(r, "reasoningEffort"); ok && contains(validEfforts, trim(e)) {
		out.Set("reasoningEffort", trim(e))
	}
	if ct, ok := strField(r, "costTier"); ok && contains(validCostTiers, trim(ct)) {
		out.Set("costTier", trim(ct))
	}
	return out
}

func sanitizeRouteTarget(raw any) *util.Obj {
	r, ok := raw.(*util.Obj)
	if !ok || r == nil {
		return nil
	}
	kind := trim(util.Str(r.Get("kind")))
	switch kind {
	case "preset":
		pid := slice(trim(util.Str(r.Get("presetId"))), 64)
		if pid == "" || !profileIDRe.MatchString(pid) {
			return nil
		}
		return util.NewObj("kind", "preset", "presetId", pid)
	case "custom":
		cli := ResolveDelegateCli(r.Get("cli"))
		if cli == "" || !IsDelegateCli(cli) {
			return nil
		}
		src := normalizeRunnerSourceForCli(cli, trim(util.Str(r.Get("source"))))
		out := util.NewObj("kind", "custom", "cli", cli, "source", src)
		if src == "official" {
			if acc := slice(trim(util.Str(r.Get("accountId"))), 128); acc != "" && !strings.HasPrefix(acc, "local-") {
				out.Set("accountId", acc)
			}
		}
		if m := slice(trim(util.Str(r.Get("model"))), 128); m != "" {
			out.Set("model", m)
		}
		if e := trim(util.Str(r.Get("reasoningEffort"))); contains(validEfforts, e) {
			out.Set("reasoningEffort", e)
		}
		return out
	}
	return nil
}

// FindPreset 在预设列表中按 id 查找，找不到返回 nil。
func FindPreset(presets []any, id string) *util.Obj {
	want := trim(id)
	if want == "" {
		return nil
	}
	for _, x := range presets {
		if p, ok := x.(*util.Obj); ok && p != nil && util.Str(p.Get("id")) == want {
			return p
		}
	}
	return nil
}

// RoutingEnv：计算默认预设与有效路由所需的环境快照。
type RoutingEnv struct {
	Installed         []string
	HasOfficial       func(string) bool
	DefaultOfficialID func(string) string
	HasLocal          func(string) bool
	OfficialModels    func(cli, source string) []string
	ThirdPartyMain    func(string) string
	GatewayModels     []string
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if t := trim(x); t != "" {
			return t
		}
	}
	return ""
}

// DeriveEffectiveRouting 生成含默认预设与 7 类路由映射的有效配置（兼容旧签名）。
func DeriveEffectiveRouting(settings *util.Obj, installed []string, hasOfficial, hasLocal func(string) bool, thirdPartyMain func(string) string, gatewayFallback ...string) (bool, []any, *util.Obj) {
	var gwModels []string
	if len(gatewayFallback) > 0 {
		if fb := trim(gatewayFallback[0]); fb != "" {
			gwModels = []string{fb}
		}
	}
	return DeriveEffectiveRoutingWithEnv(settings, RoutingEnv{
		Installed:      installed,
		HasOfficial:    hasOfficial,
		HasLocal:       hasLocal,
		ThirdPartyMain: thirdPartyMain,
		GatewayModels:  gwModels,
	})
}

// DeriveEffectiveRoutingWithEnv 按环境状态生成默认预设与 7 类路由：
// 1. 未安装任何 CLI（且无自定义预设）时返回空预设与空默认路由，由后台 Nomi 隐式承接；
// 2. 已安装 CLI 时以已配置主力 CLI 为主，复杂档匹配该 CLI 同族次顶级模型；
// 3. 仅有第三方网关模型时，轻量/简单档优选高性价比顶级轻量模型（ds4.1 / kimi3 / glm-flash 等）。
func DeriveEffectiveRoutingWithEnv(settings *util.Obj, env RoutingEnv) (bool, []any, *util.Obj) {
	if settings == nil {
		settings = util.NewObj()
	}
	autoComplexity := true
	if b, ok := settings.Get("autoComplexity").(bool); ok {
		autoComplexity = b
	}
	defaults, _ := settings.Get("defaults").(*util.Obj)
	installed := env.Installed
	gwModels := env.GatewayModels
	fallbackModel := ""
	if len(gwModels) > 0 {
		fallbackModel = trim(gwModels[0])
	}

	hasOff := func(c string) bool {
		return builtin.WithAccounts(c) && env.HasOfficial != nil && env.HasOfficial(c)
	}
	hasLoc := func(c string) bool {
		return builtin.WithAccounts(c) && env.HasLocal != nil && env.HasLocal(c)
	}
	tpMain := func(c string) string {
		if env.ThirdPartyMain == nil {
			return ""
		}
		return trim(env.ThirdPartyMain(c))
	}
	offModels := func(c, src string) []string {
		if env.OfficialModels == nil {
			return nil
		}
		return env.OfficialModels(c, src)
	}

	// 挑选主力 CLI：defaults.coding（已安装）> 已接通官方/本地的 CLI > 配了第三方主模型的 CLI > 含原生同族网关模型的 CLI > installed[0]
	primaryCli := ""
	if defaults != nil {
		if c := ResolveDelegateCli(defaults.Get("coding")); c != "" && contains(installed, c) {
			primaryCli = c
		}
	}
	if primaryCli == "" {
		for _, c := range installed {
			if hasOff(c) || hasLoc(c) {
				primaryCli = c
				break
			}
		}
	}
	if primaryCli == "" {
		for _, c := range installed {
			if tpMain(c) != "" {
				primaryCli = c
				break
			}
		}
	}
	if primaryCli == "" && len(gwModels) > 0 {
		for _, c := range installed {
			if PickSubTopModelForCli(c, gwModels) != "" {
				primaryCli = c
				break
			}
		}
	}
	if primaryCli == "" && len(installed) > 0 {
		primaryCli = installed[0]
	}

	pickTpModel := func(c string, balanced bool) string {
		pool := append([]string(nil), gwModels...)
		mainRef := tpMain(c)
		if mainRef != "" && !contains(pool, mainRef) {
			pool = append(pool, mainRef)
		}
		if len(pool) == 0 {
			return ""
		}
		if balanced {
			if m := PickBalancedModelForCli(c, pool); m != "" {
				return m
			}
		}
		if m := PickSubTopModelForCli(c, pool); m != "" {
			return m
		}
		return PickFallbackSubTopModel(pool, firstNonEmpty(mainRef, fallbackModel))
	}

	pickHighSource := func(c string) (source, accountID, model string) {
		if c == "" {
			return "", "", ""
		}
		if !builtin.WithAccounts(c) {
			return "thirdParty", "", pickTpModel(c, false)
		}
		if hasOff(c) {
			accID := ""
			if env.DefaultOfficialID != nil {
				accID = trim(env.DefaultOfficialID(c))
			}
			return "official", accID, DefaultOfficialSubTopModel(c, offModels(c, "official"))
		}
		if hasLoc(c) {
			return "local", "", DefaultOfficialSubTopModel(c, offModels(c, "local"))
		}
		if m := pickTpModel(c, false); m != "" {
			return "thirdParty", "", m
		}
		return "official", "", ""
	}

	pickBalancedSource := func(c, hiSrc, hiAcc, hiModel string) (source, accountID, model string) {
		if c == "" {
			return "", "", ""
		}
		if hiSrc == "thirdParty" {
			return "thirdParty", "", firstNonEmpty(pickTpModel(c, true), hiModel)
		}
		if hiSrc == "official" && hasOff(c) {
			cached := offModels(c, "official")
			if m := PickBalancedModelForCli(c, cached); m != "" {
				return "official", hiAcc, m
			}
		} else if hiSrc == "local" && hasLoc(c) {
			cached := offModels(c, "local")
			if m := PickBalancedModelForCli(c, cached); m != "" {
				return "local", "", m
			}
		}
		return hiSrc, hiAcc, hiModel
	}

	var presets []any
	if rawPresets := toList(settings.Get("presets")); len(rawPresets) > 0 {
		presets = make([]any, len(rawPresets))
		for i, x := range rawPresets {
			if o, ok := x.(*util.Obj); ok && o != nil {
				presets[i] = o.Clone()
			}
		}
	} else if len(installed) == 0 {
		// 规则 1：本机未安装任何 CLI 时，不伪造未安装预设，默认由后台 Nomi 隐式承接
		presets = []any{}
	} else {
		hiSrc, hiAcc, hiModel := pickHighSource(primaryCli)
		high := util.NewObj("id", "high", "label", "高质量主力", "cli", primaryCli, "source", hiSrc)
		if hiSrc == "official" && hiAcc != "" {
			high.Set("accountId", hiAcc)
		}
		if hiModel != "" {
			high.Set("model", hiModel)
		}
		high.Set("reasoningEffort", "high").Set("costTier", "high")

		balSrc, balAcc, balModel := pickBalancedSource(primaryCli, hiSrc, hiAcc, hiModel)
		bal := util.NewObj("id", "balanced", "label", "日常均衡", "cli", primaryCli, "source", balSrc)
		if balSrc == "official" && balAcc != "" {
			bal.Set("accountId", balAcc)
		}
		if balModel != "" {
			bal.Set("model", balModel)
		}
		bal.Set("reasoningEffort", "medium").Set("costTier", "medium")

		// 规则 3：只要有可用的第三方模型池，简单/低成本档在池中挑选性价比最高的顶级轻量模型（ds4.1 / kimi3 / glm-flash）
		lowCli, lowSrc, lowAcc, lowModel := primaryCli, hiSrc, hiAcc, hiModel
		tpPool := append([]string(nil), gwModels...)
		preferredLowTp := ""
		if m := tpMain(primaryCli); m != "" {
			preferredLowTp = m
			if !contains(tpPool, m) {
				tpPool = append(tpPool, m)
			}
		}
		for _, c := range installed {
			if m := tpMain(c); m != "" {
				if preferredLowTp == "" {
					preferredLowTp = m
				}
				if !contains(tpPool, m) {
					tpPool = append(tpPool, m)
				}
			}
		}
		if len(tpPool) > 0 {
			lowSrc = "thirdParty"
			lowAcc = ""
			lowModel = PickBestValueSimpleModel(tpPool, firstNonEmpty(preferredLowTp, fallbackModel))
			if !builtin.WithThirdParty(lowCli) {
				for _, c := range installed {
					if builtin.WithThirdParty(c) {
						lowCli = c
						break
					}
				}
			}
		} else if hiSrc == "official" && hasOff(lowCli) {
			lowModel = DefaultOfficialLightModel(lowCli, offModels(lowCli, "official"))
		} else if hiSrc == "local" && hasLoc(lowCli) {
			lowModel = DefaultOfficialLightModel(lowCli, offModels(lowCli, "local"))
		}

		low := util.NewObj("id", "low", "label", "轻量省钱", "cli", lowCli, "source", lowSrc)
		if lowSrc == "official" && lowAcc != "" {
			low.Set("accountId", lowAcc)
		}
		if lowModel != "" {
			low.Set("model", lowModel)
		}
		low.Set("reasoningEffort", "low").Set("costTier", "low")
		presets = []any{high, bal, low}
	}

	savedRoutes, _ := settings.Get("routes").(*util.Obj)
	routes := util.NewObj()
	fallbackPresetFor := map[string]string{
		"complex":   "high",
		"coding":    "balanced",
		"review":    "balanced",
		"research":  "low",
		"prd":       "low",
		"simple":    "low",
		"scheduled": "low",
	}
	for _, kind := range RoutableTaskKinds {
		if savedRoutes != nil {
			if rt, ok := savedRoutes.Get(kind).(*util.Obj); ok && rt != nil {
				routes.Set(kind, rt.Clone())
				continue
			}
		}
		// 若旧 defaults 显式指定了不同于主力 CLI 的已安装助手，自动尊重旧配置
		if defaults != nil && (kind == "coding" || kind == "review" || kind == "research" || kind == "prd") {
			if dc := ResolveDelegateCli(defaults.Get(kind)); dc != "" && dc != primaryCli && contains(installed, dc) {
				dSrc, dAcc, dModel := pickHighSource(dc)
				rt := util.NewObj("kind", "custom", "cli", dc, "source", dSrc)
				if dSrc == "official" && dAcc != "" {
					rt.Set("accountId", dAcc)
				}
				if dModel != "" {
					rt.Set("model", dModel)
				}
				routes.Set(kind, rt)
				continue
			}
		}
		if len(presets) == 0 {
			continue
		}
		pid := fallbackPresetFor[kind]
		if FindPreset(presets, pid) == nil {
			if first, ok := presets[0].(*util.Obj); ok && first != nil {
				pid = util.Str(first.Get("id"))
			}
		}
		routes.Set(kind, util.NewObj("kind", "preset", "presetId", pid))
	}
	return autoComplexity, presets, routes
}

// ResolveInput：ResolveTaskRunner 入参
type ResolveInput struct {
	Pinned             string
	RequestedPreset    string
	RequestedCli       string
	RequestedSource    string
	RequestedAccountID string
	Kind               string
	Complexity         string
	AutoComplexity     bool
	HasExplicitRouting bool
	Presets            []any
	Routes             *util.Obj
	Defaults           *util.Obj
	Installed          []string
}

func runnerFromPresetObj(p *util.Obj, by string) *ResolvedRunner {
	if p == nil {
		return nil
	}
	return &ResolvedRunner{
		Cli:             util.Str(p.Get("cli")),
		By:              by,
		PresetID:        util.Str(p.Get("id")),
		Source:          util.Str(p.Get("source")),
		AccountID:       util.Str(p.Get("accountId")),
		Model:           util.Str(p.Get("model")),
		ReasoningEffort: util.Str(p.Get("reasoningEffort")),
	}
}

func runnerFromCustomObj(r *util.Obj, by string) *ResolvedRunner {
	if r == nil {
		return nil
	}
	return &ResolvedRunner{
		Cli:             util.Str(r.Get("cli")),
		By:              by,
		Source:          util.Str(r.Get("source")),
		AccountID:       util.Str(r.Get("accountId")),
		Model:           util.Str(r.Get("model")),
		ReasoningEffort: util.Str(r.Get("reasoningEffort")),
	}
}

// ResolveTaskRunner：按照 Pin > preset > explicit cli > complexity/route > PickDelegateCli 选择本次执行的组合。
func ResolveTaskRunner(i ResolveInput) *ResolvedRunner {
	okCli := func(c string) bool { return c != "" && contains(i.Installed, c) }

	// 1. Pinned 最高优先级（支持 "preset:<id>" 或 cli id）
	if strings.HasPrefix(i.Pinned, "preset:") {
		pid := strings.TrimPrefix(i.Pinned, "preset:")
		if p := FindPreset(i.Presets, pid); p != nil {
			if okCli(util.Str(p.Get("cli"))) {
				return runnerFromPresetObj(p, "pinned")
			}
		}
		return nil
	}
	if i.Pinned != "" {
		if okCli(i.Pinned) {
			return &ResolvedRunner{Cli: i.Pinned, By: "pinned"}
		}
		return nil
	}

	// 2. 显式指定 preset 参数
	if pid := trim(i.RequestedPreset); pid != "" {
		if p := FindPreset(i.Presets, pid); p != nil {
			if okCli(util.Str(p.Get("cli"))) {
				return runnerFromPresetObj(p, "preset")
			}
		}
		return nil
	}

	// 3. 显式指定 cli（及可选 source / accountId）
	if okCli(i.RequestedCli) {
		return &ResolvedRunner{
			Cli:       i.RequestedCli,
			By:        "requested",
			Source:    i.RequestedSource,
			AccountID: i.RequestedAccountID,
		}
	}

	// 4. 路由表匹配（启用复杂路由 / 已配新路由表时）
	if i.HasExplicitRouting || trim(i.Complexity) != "" {
		routeKey := i.Kind
		if routeKey == "" {
			routeKey = "coding"
		}
		if i.AutoComplexity {
			switch trim(i.Complexity) {
			case "high":
				routeKey = "complex"
			case "low":
				routeKey = "simple"
			}
		}
		if i.Routes != nil {
			if rt, ok := i.Routes.Get(routeKey).(*util.Obj); ok && rt != nil {
				switch util.Str(rt.Get("kind")) {
				case "preset":
					if p := FindPreset(i.Presets, util.Str(rt.Get("presetId"))); p != nil && okCli(util.Str(p.Get("cli"))) {
						return runnerFromPresetObj(p, "route:"+routeKey)
					}
				case "custom":
					if okCli(util.Str(rt.Get("cli"))) {
						return runnerFromCustomObj(rt, "route:"+routeKey)
					}
				}
			}
		}
	}

	// 5. 向后兼容默认回退（PickDelegateCli）
	picked := PickDelegateCli(PickInput{
		Kind:      i.Kind,
		Defaults:  i.Defaults,
		Installed: i.Installed,
	})
	if picked == nil {
		return nil
	}
	return &ResolvedRunner{Cli: picked.Cli, By: picked.By}
}

// OverridesInput：resolveDelegateOverrides 的入参；nil 指针 = undefined/null（Has* 区分 null）
type OverridesInput struct {
	Model           any // string | nil
	ReasoningEffort any // string | nil（undefined 与 null 同样视为未给）
	Profile         any
	Settings        *util.Obj
}

// ResolveDelegateOverrides：显式 model > profile.model >（cheap 时 settings.cheapModel）> 不覆盖。
// 返回 { ok:true, profileId, model?, reasoningEffort?, preferLocal? } 或 { ok:false, code, message }
func ResolveDelegateOverrides(in OverridesInput) *util.Obj {
	s := in.Settings
	profiles := MergeAgentProfiles(s.Get("profiles"))
	requested := ""
	if p, ok := in.Profile.(string); ok {
		requested = trim(p)
	}
	if requested == "" {
		requested = util.Str(s.Get("defaultProfileId"))
	}
	if requested == "" {
		requested = "default"
	}
	var profile *util.Obj
	for _, p := range profiles {
		if p.Get("id") == requested {
			profile = p
			break
		}
	}
	if profile == nil {
		return util.NewObj("ok", false, "code", "unknown_profile", "message", "未知的委派模型档位："+requested)
	}
	explicit := ""
	if m, ok := in.Model.(string); ok {
		explicit = trim(m)
	}
	model := ""
	if explicit != "" {
		model = slice(explicit, 128)
	} else if pm := util.Str(profile.Get("model")); trim(pm) != "" {
		model = trim(pm)
	} else if profile.Get("id") == "cheap" && trim(util.Str(s.Get("cheapModel"))) != "" {
		model = trim(util.Str(s.Get("cheapModel")))
	}
	var effort any
	hasEffort := false
	if in.ReasoningEffort != nil {
		e := trim(jsString(in.ReasoningEffort))
		hasEffort = true
		if e != "" {
			effort = slice(e, 32)
		}
	} else if profile.Has("reasoningEffort") {
		hasEffort = true
		effort = profile.Get("reasoningEffort")
	}
	out := util.NewObj("ok", true, "profileId", profile.Get("id"))
	if model != "" {
		out.Set("model", model)
	}
	if hasEffort {
		out.Set("reasoningEffort", effort)
	}
	if profile.Get("preferLocal") == true {
		out.Set("preferLocal", true)
	}
	return out
}

func jsString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return util.FormatNumber(x)
	case nil:
		return "null"
	}
	return util.Stringify(v)
}

var aliases = func() map[string]string {
	m := map[string]string{"claude-code": "claude", "claudecode": "claude", "cc": "claude"}
	for _, id := range builtin.Ordered {
		m[id] = id
	}
	return m
}()

var wsRun = util.JSRe(`\s+`)

// ResolveDelegateCli：名字 → Agents id（不区分大小写，接受别名）；认不出返回 ""
func ResolveDelegateCli(name any) string {
	s, ok := name.(string)
	if !ok {
		return ""
	}
	return aliases[wsRun.ReplaceAllString(util.JSLower(trim(s)), "-")]
}

// Picked：pickDelegateCli 的结果
type Picked struct{ Cli, By string }

// PickInput：pickDelegateCli 入参；"" = null
type PickInput struct {
	Pinned, Requested, Kind string
	Defaults                *util.Obj
	Installed               []string
}

// PickDelegateCli：钉住 > 点名 > 类型默认 > coding 默认 > 已安装的第一个；都不可用返回 nil
func PickDelegateCli(i PickInput) *Picked {
	ok := func(c string) bool { return c != "" && contains(i.Installed, c) }
	if i.Pinned != "" {
		if ok(i.Pinned) {
			return &Picked{i.Pinned, "pinned"}
		}
		return nil
	}
	if ok(i.Requested) {
		return &Picked{i.Requested, "requested"}
	}
	d := i.Defaults
	if d == nil {
		d = util.NewObj()
	}
	if k, _ := d.Get(i.Kind).(string); ok(k) {
		return &Picked{k, "kind-default"}
	}
	if c, _ := d.Get("coding").(string); ok(c) {
		return &Picked{c, "coding-default"}
	}
	for _, c := range DelegateClis {
		if contains(i.Installed, c) {
			return &Picked{c, "auto"}
		}
	}
	return nil
}

var modeOrder = []string{"plan", "manual", "acceptEdits", "auto", "bypass"}

func indexOf(xs []string, v string) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}

// ChildPermissionMode：子 agent 默认不超过用户给它的档位；Nomi 处于「自动」时，
// 子 agent 至少使用 auto。永远不是 bypass。
func ChildPermissionMode(nomi, tabDefault string) string {
	if nomi == "auto" {
		return "auto"
	}
	a, b := indexOf(modeOrder, nomi), indexOf(modeOrder, tabDefault)
	if a < 0 {
		a = 0
	}
	if b < 0 {
		b = 0
	}
	m := modeOrder[min(a, b)]
	if m == "bypass" {
		return "auto"
	}
	return m
}

// ChildPermissionModeFor：Nomi 处于「自动」时，派出去的 agent 直接落到 bypass。
// 委派是后台无人值守的：任何「问一下」都没人回答，只会让任务半路死掉
// （Claude 的 auto 更是会把每个动作都拒掉，跑十几分钟后 error_during_execution）。
// 其余档位仍按「不超过用户给的档位」降级，永远不会自己升到 bypass。
func ChildPermissionModeFor(cli, nomi, tabDefault string) string {
	if nomi != "auto" {
		return ChildPermissionMode(nomi, tabDefault)
	}
	if p := builtin.Impl(cli); p != nil && p.Permissions != nil {
		if contains(p.Permissions.Supported, "bypass") {
			return "bypass"
		}
		// 没有「完全放开」档的 CLI（minimax）：退而求其次，取它能给的最高档，
		// 别默默降到只读把任务做成 dry-run。
		for i := len(modeOrder) - 2; i >= 0; i-- {
			if contains(p.Permissions.Supported, modeOrder[i]) {
				return modeOrder[i]
			}
		}
	}
	return "auto"
}

// DelegateBrief：任务说明
type DelegateBrief struct{ Goal, Context, DoneWhen, OutOfScope string }

// BuildDelegatePrompt：发给 agent 的第一条消息（prompts/text/delegate-brief.md；汇报格式的标记与 reportKeys 对应）
func BuildDelegatePrompt(b DelegateBrief) string {
	return prompts.Render("delegate-brief", DelegateBrief{Goal: trim(b.Goal), Context: trim(b.Context),
		DoneWhen: trim(b.DoneWhen), OutOfScope: trim(b.OutOfScope)})
}

var reportKeys = []struct {
	k  string
	re *regexp.Regexp
}{
	{"done", regexp.MustCompile(`^做了什么[:：]`)},
	{"changedFiles", regexp.MustCompile(`^改动的文件[:：]`)},
	{"unfinished", regexp.MustCompile(`^没做完的[:：]`)},
	{"needsUser", regexp.MustCompile(`^需要用户决定的[:：]`)},
}

var noneRe = regexp.MustCompile(`(?i)^(无|没有|none|n/a|-)?[。.]?$`)
var reportBlockRe = regexp.MustCompile(`(?s)\[nomi-report\](.*?)\[/nomi-report\]`)
var crlfRe = regexp.MustCompile(`\r?\n`)
var bulletRe = util.JSRe(`^[-*•]\s*`)
var tickRe = regexp.MustCompile("^`|`$")
var fileLineSepRe = regexp.MustCompile(`[,，、;]+`)
var fileLineStatsRe = regexp.MustCompile(`\s*\(\s*\+\d+\s*[-−]\d+\s*\)\s*$`)

func looksLikeFilePath(s string) bool {
	if s == "" || strings.ContainsAny(s, ":：") {
		return false
	}
	if strings.ContainsAny(s, "/\\") || strings.HasPrefix(s, ".") {
		return true
	}
	dot := strings.LastIndexByte(s, '.')
	return dot > 0 && dot < len(s)-1
}

// splitReportedFileLine 拆分 [nomi-report] 改动的文件行（支持逗号/顿号，及同一行空格分隔的多条文件路径）。
func splitReportedFileLine(raw string) []string {
	cleaned := trim(tickRe.ReplaceAllString(bulletRe.ReplaceAllString(raw, ""), ""))
	cleaned = trim(fileLineStatsRe.ReplaceAllString(cleaned, ""))
	if cleaned == "" || noneRe.MatchString(cleaned) {
		return nil
	}
	chunks := fileLineSepRe.Split(cleaned, -1)
	out := make([]string, 0, len(chunks))
	for _, c := range chunks {
		item := trim(tickRe.ReplaceAllString(trim(c), ""))
		item = trim(fileLineStatsRe.ReplaceAllString(item, ""))
		if item == "" || noneRe.MatchString(item) {
			continue
		}
		if fields := strings.Fields(item); len(fields) > 1 {
			allPaths := true
			stripped := make([]string, 0, len(fields))
			for _, f := range fields {
				pf := trim(tickRe.ReplaceAllString(f, ""))
				if !looksLikeFilePath(pf) {
					allPaths = false
					break
				}
				stripped = append(stripped, pf)
			}
			if allPaths && len(stripped) > 0 {
				out = append(out, stripped...)
				continue
			}
		}
		out = append(out, item)
	}
	return out
}

// ParseDelegateReport：解析最后一个 [nomi-report] 块；没有或缺「做了什么」时返回 nil。
// 结果：{ done, changedFiles, unfinished?, needsUser? }
func ParseDelegateReport(text string) *util.Obj {
	blocks := reportBlockRe.FindAllStringSubmatch(text, -1)
	if len(blocks) == 0 || blocks[len(blocks)-1][1] == "" {
		return nil
	}
	body := blocks[len(blocks)-1][1]
	parts := map[string][]string{}
	cur := ""
	for _, raw := range crlfRe.Split(body, -1) {
		line := trim(raw)
		hit := -1
		for i, rk := range reportKeys {
			if rk.re.MatchString(line) {
				hit = i
				break
			}
		}
		if hit >= 0 {
			cur = reportKeys[hit].k
			rest := trim(reportKeys[hit].re.ReplaceAllString(line, ""))
			if rest != "" {
				parts[cur] = []string{rest}
			} else {
				parts[cur] = []string{}
			}
		} else if cur != "" && line != "" {
			parts[cur] = append(parts[cur], line)
		}
	}
	join := func(k string) string {
		n := 600
		if k == "done" {
			n = 1500
		}
		return slice(trim(strings.Join(parts[k], "\n")), n)
	}
	done := join("done")
	if done == "" {
		return nil
	}
	files := []any{}
	seenFiles := map[string]bool{}
	for _, l := range parts["changedFiles"] {
		for _, item := range splitReportedFileLine(l) {
			if seenFiles[item] {
				continue
			}
			seenFiles[item] = true
			if len(files) >= 50 {
				break
			}
			files = append(files, slice(item, 200))
		}
		if len(files) >= 50 {
			break
		}
	}
	out := util.NewObj("done", done, "changedFiles", files)
	for _, k := range []string{"unfinished", "needsUser"} {
		if v := join(k); v != "" && !noneRe.MatchString(v) {
			out.Set(k, v)
		}
	}
	return out
}

var quoteEdgeRe = regexp.MustCompile(`^"|"$`)

// ParsePorcelain：git status --porcelain [-z] → 相对路径（重命名取新路径）
func ParsePorcelain(out string) []string {
	files := []string{}
	if out == "" {
		return files
	}
	if strings.Contains(out, "\x00") {
		var parts []string
		for _, s := range strings.Split(out, "\x00") {
			if s != "" {
				parts = append(parts, s)
			}
		}
		for i := 0; i < len(parts); i++ {
			ent := parts[i]
			if util.UTF16Len(ent) < 3 {
				continue
			}
			xy := ent[:2]
			file := jsSliceFrom(ent, 3)
			if (xy[0] == 'R' || xy[0] == 'C') && i+1 < len(parts) {
				i++
			}
			file = quoteEdgeRe.ReplaceAllString(file, "")
			if file != "" {
				files = append(files, file)
			}
		}
		return files
	}
	for _, line := range crlfRe.Split(out, -1) {
		if util.UTF16Len(line) < 4 {
			continue
		}
		p := jsSliceFrom(line, 3)
		if a := strings.Index(p, " -> "); a >= 0 {
			p = p[a+4:]
		}
		p = quoteEdgeRe.ReplaceAllString(p, "")
		if p != "" {
			files = append(files, p)
		}
	}
	return files
}

// jsSliceFrom：s.slice(n)（UTF-16 单位）
func jsSliceFrom(s string, n int) string {
	return s[len(util.UTF16Slice0(s, n)):]
}

// TailText：截断到 max 字符，保留结尾
func TailText(text string, max int) string {
	s := trim(text)
	if util.UTF16Len(s) <= max {
		return s
	}
	return "…" + util.UTF16Tail(s, max)
}
