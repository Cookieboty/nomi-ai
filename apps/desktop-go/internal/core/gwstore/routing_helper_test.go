package gwstore

import (
	"fmt"
	"path/filepath"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func newTestGateway(t *testing.T, ud string) *Service {
	t.Helper()
	s := NewServiceForUserData(ud, nil, nil)
	s.AttachRuntime(RuntimeDeps{
		Root: filepath.Join(ud, "gateway"),
		Lazy: true,
		Env:  map[string]string{},
		Fork: func() GatewayChild { return &syncChild{} },
	})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	return s
}

func TestSourcePoolPreservesModelsMainAcrossSwitches(t *testing.T) {
	ud := t.TempDir()
	s := newTestGateway(t, ud)
	defer s.Dispose()

	if err := s.SetAssignment("claude", mustObj(t, `{"models":{"main":"ds/deepseek-chat"}}`)); err != nil {
		t.Fatal(err)
	}
	if d := s.CliDefaults("claude"); d.Get("source") != "thirdParty" || d.Get("model") != "ds/deepseek-chat" {
		t.Fatalf("after main set: %v", u.Stringify(d))
	}

	// 切回 official 时保留 models.main
	if err := s.SetAssignment("claude", mustObj(t, `{"newTabSource":"official","newTabAccountId":"acc-1"}`)); err != nil {
		t.Fatal(err)
	}
	if d := s.CliDefaults("claude"); d.Get("source") != "official" || d.Get("accountId") != "acc-1" || d.Get("model") != "ds/deepseek-chat" {
		t.Fatalf("after switching to official: %v", u.Stringify(d))
	}

	// 切回 local 时同样保留 models.main，且不绑定 official accountId
	if err := s.SetAssignment("claude", mustObj(t, `{"newTabSource":"local"}`)); err != nil {
		t.Fatal(err)
	}
	if d := s.CliDefaults("claude"); d.Get("source") != "local" || (d.Get("accountId") != nil && d.Get("accountId") != u.Undefined) || d.Get("model") != "ds/deepseek-chat" {
		t.Fatalf("after switching to local: %v", u.Stringify(d))
	}

	// 显式同时传 models.main + newTabSource=official，不得强制改回 thirdParty
	if err := s.SetAssignment("claude", mustObj(t, `{"models":{"main":"pa/ma"},"newTabSource":"official"}`)); err != nil {
		t.Fatal(err)
	}
	s.Dispose()

	// 重启持久化后也不允许 normalizeCliAssignments 覆写回 thirdParty
	s2 := newTestGateway(t, ud)
	defer s2.Dispose()
	if d := s2.CliDefaults("claude"); d.Get("source") != "official" || d.Get("model") != "pa/ma" {
		t.Fatalf("after restart: %v", u.Stringify(d))
	}
}

func TestGlobalHelperModelFallbacksAndOverrides(t *testing.T) {
	ud := t.TempDir()
	s := newTestGateway(t, ud)
	defer s.Dispose()

	for id, m := range map[string]string{"pa": "ma", "ds": "deepseek-chat"} {
		in := mustObj(t, fmt.Sprintf(`{"name":%q,"urls":{"chat":"https://%s.example.com/v1","anthropic":"https://%s.example.com/anthropic"},`+
			`"newKeys":[{"value":"sk-%s-1234567890"}],"models":[{"id":%q,"enabled":true},{"id":"haiku-x","enabled":true}]}`, id, id, id, id, m))
		if _, err := s.UpsertProvider(in); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetAssignment("nomi", mustObj(t, `{"models":{"main":"pa/ma"}}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAssignment("claude", mustObj(t, `{"models":{"main":"pa/ma"}}`)); err != nil {
		t.Fatal(err)
	}
	_ = s.Endpoint("nomi")

	st, err := s.SetOptions(mustObj(t, `{"helperModel":"ds/deepseek-chat"}`))
	if err != nil {
		t.Fatal(err)
	}
	if st.Get("helperModel") != "ds/deepseek-chat" {
		t.Fatalf("state helperModel=%v, want ds/deepseek-chat", st.Get("helperModel"))
	}

	// Nomi summary 角色命中全局 helperModel
	if picked := s.nomiPick("summary"); picked == nil || picked.PublicModel != "ds/deepseek-chat" {
		t.Fatalf("nomiPick(summary)=%#v, want ds/deepseek-chat", picked)
	}

	// HelperRoute 命中全局 helperModel
	if hr := s.HelperRoute("claude", "pa/ma"); hr == nil || hr.Model != "ds/deepseek-chat" {
		t.Fatalf("HelperRoute=%#v, want ds/deepseek-chat", hr)
	}

	// EffectiveClientModels 补全 haiku / small / summary
	em := s.EffectiveClientModels("claude", "pa/ma")
	if objGet(em, "tiers", "haiku") != "ds/deepseek-chat" || em.Get("summary") != "ds/deepseek-chat" || em.Get("small") != "ds/deepseek-chat" {
		t.Fatalf("EffectiveClientModels=%v", u.Stringify(em))
	}

	// CliLaunch 自动写入 haiku 环境变量且使用全局 helperModel
	tl, err := s.CliLaunch("claude", "tab-helper", "pa/ma", CliLaunchOpts{TabBound: true})
	if err != nil || tl == nil {
		t.Fatalf("CliLaunch err=%v tl=%v", err, tl)
	}
	if tl.Env.Get("ANTHROPIC_DEFAULT_HAIKU_MODEL") != "ds/deepseek-chat" && tl.Env.Get("ANTHROPIC_SMALL_FAST_MODEL") != "ds/deepseek-chat" {
		t.Fatalf("claude launch env did not inherit helperModel: %v", u.Stringify(tl.Env))
	}

	// 单 CLI 显式设置 tiers.haiku 时优先级高于全局 helperModel
	if err := s.SetAssignment("claude", mustObj(t, `{"models":{"tiers":{"haiku":"pa/haiku-x"}}}`)); err != nil {
		t.Fatal(err)
	}
	if hr := s.HelperRoute("claude", "pa/ma"); hr == nil || hr.Model != "pa/haiku-x" {
		t.Fatalf("HelperRoute with client override=%#v, want pa/haiku-x", hr)
	}
}
