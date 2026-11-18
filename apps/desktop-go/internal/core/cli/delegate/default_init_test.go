package delegate

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestDefaultInitNoCliFallsBackToNomi(t *testing.T) {
	dir := t.TempDir()
	sc := util.NewObj(
		"installed", []any{},
		"granted", []any{dir},
		"recent", []any{dir},
	)
	log := &envLog{}
	h := &fakeHarness{sc: sc, base: dir, log: log, cancelCh: make(chan struct{}, 4)}
	dk := &fakeDesktop{sc: sc, base: dir, log: log}
	tp := newFakeTasks()
	svc := New(Deps{
		Root:         t.TempDir(),
		Harness:      h,
		Desktop:      dk,
		Events:       fakeEvents{log},
		Edits:        NewEditLog(),
		Tasks:        tp,
		RetryBackoff: func(int) time.Duration { return 0 },
	})
	defs := map[string]tools.Definition{}
	for _, x := range svc.Tools() {
		defs[x.Name] = x
	}

	// 规则 1：未安装任何 CLI 时，不生成虚假 CLI 预设
	st := svc.Settings()
	if presets, _ := st.Get("presets").([]any); len(presets) != 0 {
		t.Fatalf("expected empty presets when no CLI installed, got %s", util.Stringify(st))
	}
	if svc.CliAvailable() {
		t.Fatalf("expected CliAvailable() == false when no CLI installed")
	}

	// 即使从工具层走 delegate_to_cli（未点名外部 CLI），也应隐式回退由后台 Nomi 承接
	res, err := defs["delegate_to_cli"].Execute(context.Background(), util.NewObj(
		"goal", "整理本周发布清单",
		"done_when", "输出 markdown 清单",
		"kind", "prd",
	), tools.ExecContext{ReqID: "req-nocli-1", ConversationID: "conv-nocli"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	rObj := res.(*util.Obj)
	if rObj.Get("ok") != true || util.Str(dataOf(rObj).Get("cli")) != "nomi" {
		t.Fatalf("expected fallback to nomi, got %s", util.Stringify(rObj))
	}
	if len(tp.created) != 1 || tp.created[0].Executor.Kind != "nomi" || tp.created[0].Category != "writing" {
		t.Fatalf("unexpected fallback task: %+v", tp.created)
	}

	// Dispatch（未传外部 CLI 或传 nomi）同样无缝交给后台 Nomi
	disp, err := svc.Dispatch(context.Background(), DispatchInput{
		Goal:           "检查文档链接有效性",
		ConversationID: "conv-nocli",
		TurnID:         "req-nocli-2",
	})
	if err != nil || util.Str(disp.Get("cli")) != "nomi" {
		t.Fatalf("Dispatch fallback failed: err=%v data=%s", err, util.Stringify(disp))
	}
	dispPreset, err := svc.Dispatch(context.Background(), DispatchInput{
		PresetID:       "low",
		Goal:           "使用默认轻量入口后台执行",
		ConversationID: "conv-nocli",
		TurnID:         "req-nocli-3",
	})
	if err != nil || util.Str(dispPreset.Get("cli")) != "nomi" {
		t.Fatalf("Dispatch builtin preset fallback failed: err=%v data=%s", err, util.Stringify(dispPreset))
	}

	// 若用户显式点名了未安装的外部 CLI，仍须明确报未安装
	if _, err := svc.Dispatch(context.Background(), DispatchInput{
		Cli:            "codex",
		Goal:           "尝试点名未安装 CLI",
		ConversationID: "conv-nocli",
	}); err == nil || !strings.Contains(err.Error(), "没有安装") {
		t.Fatalf("expected cli_unavailable for explicit un-installed codex, got %v", err)
	}
}

func TestDefaultInitCliSubTopFamilyMatching(t *testing.T) {
	// 场景 A：同时安装 claude 与 codex，但只配了 codex 的官方账号 -> 主力 CLI 自动选已配置的 codex；
	// 且若模型含 Ultra+Flagship+SubTop，复杂档选次顶级模型
	_, presetsA, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed: []string{"claude", "codex"},
		HasOfficial: func(c string) bool {
			return c == "codex"
		},
		DefaultOfficialID: func(c string) string {
			if c == "codex" {
				return "acc-codex-1"
			}
			return ""
		},
		OfficialModels: func(c, src string) []string {
			if c == "codex" {
				return []string{"gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"}
			}
			return nil
		},
	})
	highA := FindPreset(presetsA, "high")
	if highA == nil || util.Str(highA.Get("cli")) != "codex" || util.Str(highA.Get("source")) != "official" ||
		util.Str(highA.Get("accountId")) != "acc-codex-1" || util.Str(highA.Get("model")) != "gpt-6.1-sol" {
		t.Fatalf("scenario A high preset mismatch: %s", util.Stringify(highA))
	}

	// 场景 B：Claude Code 官方目录含 Fable + Opus + Sonnet -> 次顶级选 Opus；仅含 Opus + Sonnet -> 次顶级选 Sonnet
	_, presetsFable, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed:   []string{"claude"},
		HasOfficial: func(c string) bool { return c == "claude" },
		OfficialModels: func(c, _ string) []string {
			return []string{"default", "claude-fable-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"}
		},
	})
	if m := util.Str(FindPreset(presetsFable, "high").Get("model")); m != "claude-opus-4-6" {
		t.Fatalf("expected claude-opus-4-6 when fable exists, got %q", m)
	}
	if m := util.Str(FindPreset(presetsFable, "balanced").Get("model")); m != "claude-sonnet-4-6" {
		t.Fatalf("expected balanced=claude-sonnet-4-6, got %q", m)
	}

	_, presetsOpus, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed: []string{"claude"},
		HasLocal:  func(c string) bool { return c == "claude" },
		OfficialModels: func(c, _ string) []string {
			return []string{"default", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"}
		},
	})
	highOpus := FindPreset(presetsOpus, "high")
	if util.Str(highOpus.Get("source")) != "local" || util.Str(highOpus.Get("model")) != "claude-sonnet-4-6" {
		t.Fatalf("expected local claude sub-top=claude-sonnet-4-6, got %s", util.Stringify(highOpus))
	}

	// 本机已登录但官方目录尚未缓存时，Claude Code 也显式给出次顶级 "sonnet" 而非空白默认
	_, presetsUncached, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed: []string{"claude"},
		HasLocal:  func(c string) bool { return c == "claude" },
	})
	if m := util.Str(FindPreset(presetsUncached, "high").Get("model")); m != "sonnet" {
		t.Fatalf("expected uncached local claude high model=sonnet, got %q", m)
	}

	// 场景 C：无官方/无本机登录、仅有第三方时，Codex 在多家族网关池中精准匹配 GPT 同族次顶级（跳过更贵的 Astra 与异族模型）
	_, presetsCodexTp, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed: []string{"codex"},
		GatewayModels: []string{
			"amux/deepseek-v4.1-flash",
			"amux/claude-opus-4-6",
			"amux/gpt-6-astra",
			"amux/gpt-6.1-sol",
			"amux/gpt-6.1-terra",
			"amux/gpt-6-luna",
		},
	})
	highCodexTp := FindPreset(presetsCodexTp, "high")
	balCodexTp := FindPreset(presetsCodexTp, "balanced")
	if util.Str(highCodexTp.Get("source")) != "thirdParty" || util.Str(highCodexTp.Get("model")) != "amux/gpt-6.1-sol" {
		t.Fatalf("expected codex third-party sub-top=amux/gpt-6.1-sol, got %s", util.Stringify(highCodexTp))
	}
	if util.Str(balCodexTp.Get("model")) != "amux/gpt-6.1-terra" {
		t.Fatalf("expected codex third-party balanced=amux/gpt-6.1-terra, got %s", util.Stringify(balCodexTp))
	}
}

func TestDefaultInitThirdPartyOnlySimpleUsesBestValueTopModel(t *testing.T) {
	// 即便列表首位或 thirdPartyMain 是昂贵模型，无官方/本机登录下的简单任务（low）也要挑高性价比顶级模型
	cases := []struct {
		name   string
		models []string
		want   string
	}{
		{
			name:   "prefer deepseek v4.1 (ds4.1)",
			models: []string{"amux/gpt-6-astra", "amux/glm-5.3-flash", "amux/kimi-k3", "amux/deepseek-v4.1-flash"},
			want:   "amux/deepseek-v4.1-flash",
		},
		{
			name:   "prefer kimi3 when ds4.1 absent",
			models: []string{"amux/claude-fable-5", "amux/glm-5.3-flash", "amux/kimi-k3", "amux/deepseek-chat"},
			want:   "amux/kimi-k3",
		},
		{
			name:   "prefer glm flash when ds4.1 and kimi3 absent",
			models: []string{"amux/gpt-6.1-sol", "amux/glm-5.3-flash", "amux/claude-haiku-4-5"},
			want:   "amux/glm-5.3-flash",
		},
		{
			name:   "support glm3-flash alias",
			models: []string{"amux/claude-opus-4-6", "amux/glm3-flash", "amux/deepseek-chat"},
			want:   "amux/glm3-flash",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gw := &routingFakeGateway{source: "thirdParty", models: tc.models}
			tp := newFakeTasks()
			svc, defs, _, _, dir := newRoutingTestEnv(t, gw, tp)
			st := svc.Settings()
			presets, _ := st.Get("presets").([]any)
			low := FindPreset(presets, "low")
			if low == nil || util.Str(low.Get("source")) != "thirdParty" || util.Str(low.Get("model")) != tc.want {
				t.Fatalf("got low=%s, want model %q", util.Stringify(low), tc.want)
			}

			// 真实发起一次简单委派，验证落到该高性价比模型
			res, err := defs["delegate_to_cli"].Execute(context.Background(), util.NewObj(
				"goal", "快速汇总目录结构",
				"done_when", "输出列表",
				"cwd", dir,
				"complexity", "low",
			), tools.ExecContext{ReqID: "req-tp-low", ConversationID: "conv-tp"})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.(*util.Obj).Get("ok") != true {
				t.Fatalf("delegate failed: %s", util.Stringify(res))
			}
			ex := tp.created[len(tp.created)-1].Executor
			if ex.Source == nil || *ex.Source != "thirdParty" || ex.Model == nil || *ex.Model != tc.want {
				t.Fatalf("executor=%+v, want thirdParty model %q", ex, tc.want)
			}
		})
	}
}
