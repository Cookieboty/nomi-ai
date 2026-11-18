package delegate

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type routingFakeGateway struct {
	source string
	models []string
}

func (g *routingFakeGateway) Defaults(cli string) *util.Obj {
	m := ""
	if g.source == "thirdParty" && len(g.models) > 0 {
		m = g.models[0]
	}
	return util.NewObj("source", g.source, "model", m)
}

func (g *routingFakeGateway) Models() []*util.Obj {
	out := make([]*util.Obj, 0, len(g.models))
	for _, r := range g.models {
		out = append(out, util.NewObj("ref", r))
	}
	return out
}

func newRoutingTestEnv(t *testing.T, gw *routingFakeGateway, tp *fakeTasks) (*Service, map[string]tools.Definition, *fakeHarness, *envLog, string) {
	t.Helper()
	dir := t.TempDir()
	sc := util.NewObj(
		"installed", []any{"claude"},
		"granted", []any{dir},
		"recent", []any{dir},
	)
	log := &envLog{}
	h := &fakeHarness{sc: sc, base: dir, log: log, cancelCh: make(chan struct{}, 4)}
	dk := &fakeDesktop{sc: sc, base: dir, log: log}
	svc := New(Deps{
		Root:         t.TempDir(),
		Harness:      h,
		Desktop:      dk,
		Gateway:      gw,
		Events:       fakeEvents{log},
		Edits:        NewEditLog(),
		Tasks:        tp,
		RetryBackoff: func(int) time.Duration { return 0 },
	})
	defs := map[string]tools.Definition{}
	for _, x := range svc.Tools() {
		defs[x.Name] = x
	}
	return svc, defs, h, log, dir
}

func TestMultiSourceRoutingDecouplesFromGatewayGlobalSource(t *testing.T) {
	gw := &routingFakeGateway{source: "thirdParty", models: []string{"ds/deepseek-chat"}}
	tp := newFakeTasks()
	svc, defs, _, _, dir := newRoutingTestEnv(t, gw, tp)

	settingsIn := util.NewObj(
		"autoComplexity", true,
		"presets", []any{
			util.NewObj("id", "high", "label", "高质量主力", "cli", "claude", "source", "official", "accountId", "acc-pro", "model", "claude-opus-4-6", "reasoningEffort", "high", "costTier", "high"),
			util.NewObj("id", "low", "label", "轻量省钱", "cli", "claude", "source", "thirdParty", "model", "ds/deepseek-chat", "reasoningEffort", "low", "costTier", "low"),
			util.NewObj("id", "localp", "label", "本机登录", "cli", "claude", "source", "local", "model", "claude-sonnet-4-6"),
		},
		"routes", util.NewObj(
			"complex", util.NewObj("kind", "preset", "presetId", "high"),
			"simple", util.NewObj("kind", "preset", "presetId", "low"),
			"coding", util.NewObj("kind", "preset", "presetId", "high"),
		),
	)
	if _, err := svc.SetSettings(settingsIn); err != nil {
		t.Fatalf("SetSettings: %v", err)
	}

	callTool := func(args *util.Obj, reqID string) *util.Obj {
		res, err := defs["delegate_to_cli"].Execute(context.Background(), args, tools.ExecContext{
			ReqID:          reqID,
			ConversationID: "conv-1",
		})
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		return res.(*util.Obj)
	}

	// 场景 A：全局网关默认为 thirdParty，但 complexity="high" 命中 official + acc-pro + claude-opus-4-6，绝不能误查网关目录
	gw.source = "thirdParty"
	resA := callTool(util.NewObj(
		"goal", "架构重构认证模块",
		"done_when", "测试通过",
		"cwd", dir,
		"complexity", "high",
	), "req-a")
	if resA.Get("ok") != true {
		t.Fatalf("scenario A failed: %v", util.Stringify(resA))
	}
	exA := tp.created[len(tp.created)-1].Executor
	if exA.Source == nil || *exA.Source != "official" || exA.AccountID == nil || *exA.AccountID != "acc-pro" ||
		exA.Model == nil || *exA.Model != "claude-opus-4-6" || exA.PresetID == nil || *exA.PresetID != "high" {
		t.Fatalf("scenario A unexpected executor: %+v", exA)
	}

	// 场景 B：全局网关切回 official，但 complexity="low" 命中 thirdParty + ds/deepseek-chat
	gw.source = "official"
	resB := callTool(util.NewObj(
		"goal", "快速整理依赖清单",
		"done_when", "输出列表",
		"cwd", dir,
		"complexity", "low",
	), "req-b")
	if resB.Get("ok") != true {
		t.Fatalf("scenario B failed: %v", util.Stringify(resB))
	}
	exB := tp.created[len(tp.created)-1].Executor
	if exB.Source == nil || *exB.Source != "thirdParty" || exB.AccountID != nil ||
		exB.Model == nil || *exB.Model != "ds/deepseek-chat" || exB.PresetID == nil || *exB.PresetID != "low" {
		t.Fatalf("scenario B unexpected executor: %+v", exB)
	}

	// 传不存在的第三方模型时，即便全局是 official，因 preset="low" 是 thirdParty 也必须拦截
	resBad := callTool(util.NewObj(
		"goal", "测试无效模型拦截",
		"done_when", "报错",
		"cwd", dir,
		"preset", "low",
		"model", "ds/missing",
	), "req-bad")
	if resBad.Get("ok") == true || util.Str(resBad.Get("error").(*util.Obj).Get("code")) != "model_not_in_catalog" {
		t.Fatalf("expected model_not_in_catalog, got: %v", util.Stringify(resBad))
	}

	// 场景 C：Pin("preset:localp", turnID) 后忽略全局设置直接走 local
	pinnedVal, err := svc.Pin("preset:localp", "turn-1")
	if err != nil || pinnedVal != "preset:localp" {
		t.Fatalf("Pin err=%v val=%q", err, pinnedVal)
	}
	resC := callTool(util.NewObj(
		"goal", "本机 CLI 修复",
		"done_when", "完成",
		"cwd", dir,
	), "turn-1")
	if resC.Get("ok") != true {
		t.Fatalf("scenario C failed: %v", util.Stringify(resC))
	}
	exC := tp.created[len(tp.created)-1].Executor
	if exC.Source == nil || *exC.Source != "local" || exC.AccountID != nil ||
		exC.Model == nil || *exC.Model != "claude-sonnet-4-6" || exC.PresetID == nil || *exC.PresetID != "localp" {
		t.Fatalf("scenario C unexpected executor: %+v", exC)
	}

	// 场景 D：Dispatch 按 presetId 派发 & ResolvePresetForTask
	if ps := svc.ResolvePresetForTask("low"); ps == nil || ps.Cli != "claude" || ps.Source != "thirdParty" || ps.Model != "ds/deepseek-chat" {
		t.Fatalf("ResolvePresetForTask(low)=%+v", ps)
	}
	dispData, err := svc.Dispatch(context.Background(), DispatchInput{
		PresetID:       "high",
		Goal:           "架构重构",
		ConversationID: "conv-1",
		TurnID:         "turn-disp",
	})
	if err != nil || dispData == nil {
		t.Fatalf("Dispatch failed: err=%v data=%v", err, dispData)
	}
	exD := tp.created[len(tp.created)-1].Executor
	if exD.Source == nil || *exD.Source != "official" || exD.AccountID == nil || *exD.AccountID != "acc-pro" ||
		exD.Model == nil || *exD.Model != "claude-opus-4-6" {
		t.Fatalf("scenario D unexpected executor: %+v", exD)
	}
}

func TestReuseKeyWithSourcePreventsCrossSourceCollision(t *testing.T) {
	cwd := t.TempDir()
	kLegacy := ReuseKey("conv-1", "claude", cwd, "coding", "claude-opus-4-6", "high")
	kEmpty := ReuseKeyWithSource("conv-1", "claude", "", "", cwd, "coding", "claude-opus-4-6", "high")
	if kEmpty != kLegacy {
		t.Fatalf("empty source reuse key=%q, want legacy=%q", kEmpty, kLegacy)
	}

	kOfficial := ReuseKeyWithSource("conv-1", "claude", "official", "acc-pro", cwd, "coding", "claude-opus-4-6", "high")
	kOfficial2 := ReuseKeyWithSource("conv-1", "claude", "official", "acc-2", cwd, "coding", "claude-opus-4-6", "high")
	kLocal := ReuseKeyWithSource("conv-1", "claude", "local", "", cwd, "coding", "claude-opus-4-6", "high")
	kThird := ReuseKeyWithSource("conv-1", "claude", "thirdParty", "", cwd, "coding", "ds/deepseek-chat", "low")

	keys := []string{kOfficial, kOfficial2, kLocal, kThird}
	seen := map[string]bool{}
	for _, k := range keys {
		if k == "" || seen[k] {
			t.Fatalf("duplicate or empty reuse key among %v", keys)
		}
		seen[k] = true
	}
}

func TestSanitizeDelegateSettingsPreservesLegacyKeyOrder(t *testing.T) {
	legacy := util.NewObj("enabled", true, "defaults", util.NewObj("coding", "claude"))
	got := SanitizeDelegateSettings(legacy)
	wantKeys := []string{"enabled", "defaults", "defaultProfileId"}
	if !reflect.DeepEqual(got.Keys(), wantKeys) {
		t.Fatalf("legacy keys=%v, want %v (must not append new routing fields when absent)", got.Keys(), wantKeys)
	}
}

func TestSmartFallbackUsesGatewayModelAndIncludesPrdRoute(t *testing.T) {
	gw := &routingFakeGateway{source: "official", models: []string{"amux/gpt-6.1-sol"}}
	tp := newFakeTasks()
	svc, defs, _, _, dir := newRoutingTestEnv(t, gw, tp)

	st := svc.Settings()
	routes, _ := st.Get("routes").(*util.Obj)
	if routes == nil {
		t.Fatalf("missing routes in Settings(): %s", util.Stringify(st))
	}
	prdRoute, _ := routes.Get("prd").(*util.Obj)
	if prdRoute == nil || util.Str(prdRoute.Get("kind")) != "preset" || util.Str(prdRoute.Get("presetId")) != "low" {
		t.Fatalf("expected prd route defaulting to low preset, got %v", util.Stringify(prdRoute))
	}
	// 无官方账号也无本机登录、且未单独为 CLI 分配主模型时，Smart Fallback 应兜底绑定网关首个可用模型
	presets, _ := st.Get("presets").([]any)
	if len(presets) < 3 {
		t.Fatalf("expected 3 builtin presets, got %d", len(presets))
	}
	low := presets[2].(*util.Obj)
	if util.Str(low.Get("source")) != "thirdParty" || util.Str(low.Get("model")) != "amux/gpt-6.1-sol" {
		t.Fatalf("expected low preset fallback to first gateway model, got %s", util.Stringify(low))
	}
	high := presets[0].(*util.Obj)
	if util.Str(high.Get("source")) != "thirdParty" || util.Str(high.Get("model")) != "amux/gpt-6.1-sol" {
		t.Fatalf("expected high preset fallback to first gateway model when no official/local account, got %s", util.Stringify(high))
	}

	// 验证 kind="prd" 委派命中 routes["prd"] -> low 预设并使用该网关模型
	res, err := defs["delegate_to_cli"].Execute(context.Background(), util.NewObj(
		"goal", "编写需求文档",
		"done_when", "文档生成",
		"cwd", dir,
		"kind", "prd",
	), tools.ExecContext{ReqID: "req-prd", ConversationID: "conv-prd"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if r := res.(*util.Obj); r.Get("ok") != true {
		t.Fatalf("prd dispatch failed: %s", util.Stringify(r))
	}
	ex := tp.created[len(tp.created)-1].Executor
	if ex.Source == nil || *ex.Source != "thirdParty" || ex.Model == nil || *ex.Model != "amux/gpt-6.1-sol" {
		t.Fatalf("prd executor mismatch: %+v", ex)
	}
}

func TestSanitizeDelegateSettingsPreservesAllModelEffortLevels(t *testing.T) {
	in := util.NewObj(
		"autoComplexity", true,
		"presets", []any{
			util.NewObj("id", "opus-max", "label", "Opus Max", "cli", "claude", "source", "official", "model", "claude-opus-4-6", "reasoningEffort", "max", "costTier", "high"),
		},
		"routes", util.NewObj(
			"simple", util.NewObj("kind", "custom", "cli", "codex", "source", "thirdParty", "model", "amux/gpt-5", "reasoningEffort", "minimal"),
			"complex", util.NewObj("kind", "custom", "cli", "claude", "source", "official", "model", "claude-opus-4-6", "reasoningEffort", "ultra"),
		),
	)
	got := SanitizeDelegateSettings(in)
	presets, _ := got.Get("presets").([]any)
	if len(presets) != 1 || util.Str(presets[0].(*util.Obj).Get("reasoningEffort")) != "max" {
		t.Fatalf("preset reasoningEffort=max lost: %s", util.Stringify(got))
	}
	routes, _ := got.Get("routes").(*util.Obj)
	if util.Str(routes.Get("simple").(*util.Obj).Get("reasoningEffort")) != "minimal" {
		t.Fatalf("custom route reasoningEffort=minimal lost: %s", util.Stringify(got))
	}
	if util.Str(routes.Get("complex").(*util.Obj).Get("reasoningEffort")) != "ultra" {
		t.Fatalf("custom route reasoningEffort=ultra lost: %s", util.Stringify(got))
	}
}
