package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type spyMultiAccounts struct {
	calls []string
}

func (s *spyMultiAccounts) Launch(kind ports.AccountBackend, accountID *string) ports.AccountLaunch {
	id := "default"
	if accountID != nil && *accountID != "" {
		id = *accountID
	}
	s.calls = append(s.calls, string(kind)+":"+id)
	return ports.AccountLaunch{
		Env:   util.NewObj("CLAUDE_CONFIG_DIR", "/acct/"+id),
		Strip: []string{},
		Args:  []string{},
		Sig:   "official:" + id,
	}
}

func (s *spyMultiAccounts) HasAccount(ports.AccountBackend) bool { return true }

type multiSourceGateway struct {
	effortGateway
}

func (g *multiSourceGateway) Launch(_, model, _ string, _ *ports.GatewayLaunchOpts) *ports.GatewayLaunch {
	return &ports.GatewayLaunch{
		Env: util.NewObj("ANTHROPIC_BASE_URL", "http://127.0.0.1:1/anthropic", "ANTHROPIC_MODEL", model),
	}
}

func newMultiSourceOrch(t *testing.T) (*Orchestrator, *spyMultiAccounts) {
	t.Helper()
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "harness")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	idle := 0.0
	accs := &spyMultiAccounts{}
	gw := &multiSourceGateway{effortGateway{models: []ports.GatewayModel{
		{Ref: "ds/deepseek-chat", Provider: "DeepSeek", Label: "deepseek-chat"},
	}}}
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       filepath.Join(tmp, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		Gateway:          gw,
		Accounts:         accs,
	})
	return o, accs
}

func TestMultiSourceTabsCoexistAndIsolateLaunch(t *testing.T) {
	o, accs := newMultiSourceOrch(t)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		localTab := o.CreateTab(util.NewObj("backend", "claude", "source", "local", "activate", false))
		officialTab := o.CreateTab(util.NewObj("backend", "claude", "source", "official", "accountId", "a1", "activate", false))
		tpTab := o.CreateTab(util.NewObj("backend", "claude", "source", "thirdParty", "modelOverride", "ds/deepseek-chat", "activate", false))

		if got := o.sourceOf(localTab); got != "local" || localTab.Has("accountId") {
			t.Fatalf("localTab source=%q hasAccount=%v, want local without accountId", got, localTab.Has("accountId"))
		}
		if got := o.sourceOf(officialTab); got != "official" || str(officialTab, "accountId") != "a1" {
			t.Fatalf("officialTab source=%q accountId=%v, want official/a1", got, officialTab.Get("accountId"))
		}
		if got := o.sourceOf(tpTab); got != "thirdParty" || tpTab.Has("accountId") {
			t.Fatalf("tpTab source=%q hasAccount=%v, want thirdParty without accountId", got, tpTab.Has("accountId"))
		}

		lLocal := o.launchFor(localTab)
		if lLocal.sig != "local" || !lLocal.official || len(accs.calls) != 0 {
			t.Fatalf("local launch=%+v calls=%v, must not touch Nomi accounts", lLocal, accs.calls)
		}

		lOfficial := o.launchFor(officialTab)
		if lOfficial.sig != "official:a1" || len(accs.calls) != 1 || accs.calls[0] != "claude:a1" {
			t.Fatalf("official launch=%+v calls=%v, want claude:a1", lOfficial, accs.calls)
		}

		lTp := o.launchFor(tpTab)
		if lTp.official || lTp.env.Get("ANTHROPIC_BASE_URL") != "http://127.0.0.1:1/anthropic" {
			t.Fatalf("thirdParty launch=%+v, want thirdParty env", lTp)
		}
	})
}

func TestNonAccountCLIRefusesLocalSource(t *testing.T) {
	o, _ := newMultiSourceOrch(t)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		for _, b := range []string{"gemini", "dsh"} {
			tab := o.CreateTab(util.NewObj("backend", b, "source", "local", "activate", false))
			if got := o.sourceOf(tab); got != "thirdParty" {
				t.Fatalf("%s create with local fell back to %q, want thirdParty", b, got)
			}
			var threw string
			func() {
				defer func() {
					if r := recover(); r != nil {
						if j, ok := r.(jsrt.JSThrow); ok {
							threw = j.Message
						}
					}
				}()
				o.SetTabSource(str(tab, "id"), "local", nil)
			}()
			if threw == "" {
				t.Fatalf("%s SetTabSource(local) must throw", b)
			}
		}
	})
}

func TestSetTabSourceCarriesContextAndPreservesModelScopes(t *testing.T) {
	o, _ := newMultiSourceOrch(t)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		tab := o.CreateTab(util.NewObj(
			"backend", "claude",
			"source", "official",
			"accountId", "a1",
			"modelOverride", "claude-opus-4-6",
			"messages", []any{util.NewObj("id", "m1", "role", "user", "content", "fix bug", "timestamp", float64(1))},
			"activate", false,
		))
		id := str(tab, "id")
		o.tab(id).Set("cliSessionId", "sess-official")

		// official -> local: drops accountId & cliSessionId, records carried context, isolates scope
		localTab := o.SetTabSource(id, "local", sp("claude-sonnet-4-6"))
		if o.sourceOf(localTab) != "local" || localTab.Has("accountId") {
			t.Fatalf("switched to local: %v", util.Stringify(localTab))
		}
		if truthy(localTab.Get("cliSessionId")) {
			t.Fatal("official -> local must reset cliSessionId")
		}
		if !truthy(o.tab(id).Get("carriedMessages")) {
			t.Fatal("official -> local must set carriedMessages")
		}
		if str(localTab, "modelOverride") != "claude-sonnet-4-6" {
			t.Fatalf("local modelOverride=%v, want claude-sonnet-4-6", localTab.Get("modelOverride"))
		}

		// local -> thirdParty -> local -> official: each scope recovers its own modelOverride
		tpModel := "ds/deepseek-chat"
		tpTab := o.SetTabSource(id, "thirdParty", &tpModel)
		if o.sourceOf(tpTab) != "thirdParty" || str(tpTab, "modelOverride") != tpModel {
			t.Fatalf("switched to thirdParty: %v", util.Stringify(tpTab))
		}

		backLocal := o.SetTabSource(id, "local", nil)
		if str(backLocal, "modelOverride") != "claude-sonnet-4-6" {
			t.Fatalf("returning to local lost scope model: %v", backLocal.Get("modelOverride"))
		}

		backOfficial := o.SetTabSource(id, "official", nil)
		if str(backOfficial, "modelOverride") != "claude-opus-4-6" {
			t.Fatalf("returning to official lost scope model: %v", backOfficial.Get("modelOverride"))
		}
	})
}

type selectiveAccounts struct {
	has map[string]bool
}

func (a selectiveAccounts) Launch(kind ports.AccountBackend, _ *string) ports.AccountLaunch {
	return ports.AccountLaunch{Env: util.NewObj(), Strip: []string{}, Args: []string{}, Sig: "official:" + string(kind)}
}
func (a selectiveAccounts) HasAccount(kind ports.AccountBackend) bool         { return a.has[kind] }
func (a selectiveAccounts) HasSignedInAccount(kind ports.AccountBackend) bool { return a.has[kind] }

type unconfiguredOfficialGateway struct {
	models []ports.GatewayModel
}

func (g *unconfiguredOfficialGateway) Defaults(string) ports.GatewayDefaults {
	return ports.GatewayDefaults{Source: "official", Model: nil}
}
func (g *unconfiguredOfficialGateway) Launch(string, string, string, *ports.GatewayLaunchOpts) *ports.GatewayLaunch {
	return &ports.GatewayLaunch{Env: util.NewObj(), Args: []string{}, Strip: []string{}}
}
func (g *unconfiguredOfficialGateway) OfficialEnv(env *util.Obj) *util.Obj { return env }
func (g *unconfiguredOfficialGateway) Models() []ports.GatewayModel        { return g.models }
func (g *unconfiguredOfficialGateway) ReleaseAgent(string, string)         {}

func TestCreateTabFallsBackToThirdPartyOrLocalWhenNoOfficialLogin(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "harness")
	home := filepath.Join(tmp, "home")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	// 仅在 codex 写入本机登录凭证，kimi 既无本机登录也无官方账号
	_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(`{"token":"t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	idle := 0.0
	gw := &unconfiguredOfficialGateway{
		models: []ports.GatewayModel{
			{Ref: "amux/qwen3.7-flash", Provider: "Amux AI", Label: "qwen3.7-flash"},
		},
	}
	o := New(Deps{
		Root:             root,
		Home:             home,
		DefaultCwd:       filepath.Join(tmp, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		Gateway:          gw,
		Accounts:         selectiveAccounts{has: map[string]bool{"claude": true}},
	})
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		kimiTab := o.CreateTab(util.NewObj("backend", "kimi", "activate", false))
		if got := o.sourceOf(kimiTab); got != "thirdParty" {
			t.Fatalf("kimi without local/official source=%q, want thirdParty", got)
		}
		if got := str(kimiTab, "modelOverride"); got != "amux/qwen3.7-flash" {
			t.Fatalf("kimi modelOverride=%q, want amux/qwen3.7-flash", got)
		}
		if m := o.effectiveOverrides(o.tab(str(kimiTab, "id"))).model; m == nil || *m != "amux/qwen3.7-flash" {
			t.Fatalf("kimi effective model=%v, want amux/qwen3.7-flash", m)
		}

		codexTab := o.CreateTab(util.NewObj("backend", "codex", "activate", false))
		if got := o.sourceOf(codexTab); got != "local" {
			t.Fatalf("codex with local login and no official account source=%q, want local", got)
		}

		claudeTab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
		if got := o.sourceOf(claudeTab); got != "official" {
			t.Fatalf("claude with official account source=%q, want official", got)
		}
	})
}

func TestOfficialAccountTabsIgnoresIdleUnpinnedTabs(t *testing.T) {
	o, _ := newMultiSourceOrch(t)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		tab := o.CreateTab(util.NewObj("backend", "claude", "source", "official", "activate", false))
		tid := str(tab, "id")
		if got := o.OfficialAccountTabs("claude"); len(got) != 0 {
			t.Fatalf("idle unpinned tab should not count as in-use: got %v", got)
		}

		o.SetTabAccount(tid, sp("acct-1"))
		if got := o.OfficialAccountTabs("claude"); len(got) != 1 || got[0] != "acct-1" {
			t.Fatalf("pinned tab should count as in-use: got %v, want [acct-1]", got)
		}

		o.SetTabAccount(tid, nil)
		if got := o.OfficialAccountTabs("claude"); len(got) != 0 {
			t.Fatalf("after unpinning idle tab should not count as in-use: got %v", got)
		}

		o.tab(tid).Set("status", "running")
		if got := o.OfficialAccountTabs("claude"); len(got) != 1 || got[0] != nil {
			t.Fatalf("running default tab should count as in-use: got %v, want [<nil>]", got)
		}
	})
}

func TestSingleThirdPartyProviderDefaultsWithoutExplicitAssignment(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "harness")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	idle := 0.0
	gw := &unconfiguredOfficialGateway{
		models: []ports.GatewayModel{
			{Ref: "amux/gpt-4o", Provider: "Amux AI", Label: "gpt-4o"},
			{Ref: "amux/gpt-6.1-sol", Provider: "Amux AI", Label: "gpt-6.1-sol"},
		},
	}
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       filepath.Join(tmp, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		Gateway:          gw,
		Accounts:         selectiveAccounts{has: map[string]bool{}},
	})
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		cat, err := jsrt.Await(o.ModelCatalogFor("gemini", false, "thirdParty"))
		if err != nil {
			t.Fatal(err)
		}
		def := util.AsObj(cat.Get("defaultModel"))
		if def == nil || def.Get("id") != "amux/gpt-4o" {
			t.Fatalf("single-provider thirdParty catalog defaultModel = %v, want amux/gpt-4o", util.Stringify(cat))
		}

		// 清空 modelOverride 的 Gemini 标签仍应默认落在唯一供应商的首模型
		geminiTab := o.CreateTab(util.NewObj("backend", "gemini", "activate", false))
		tid := str(geminiTab, "id")
		o.tab(tid).Set("modelOverride", nil)
		if m := o.effectiveOverrides(o.tab(tid)).model; m == nil || *m != "amux/gpt-4o" {
			t.Fatalf("gemini effective model = %v, want amux/gpt-4o", m)
		}

		// 从官方切换到第三方（不传 model）在单供应商时不应报未分配错误
		claudeTab := o.CreateTab(util.NewObj("backend", "claude", "source", "official", "activate", false))
		switched := o.SetTabSource(str(claudeTab, "id"), "thirdParty", nil)
		if got := o.sourceOf(switched); got != "thirdParty" {
			t.Fatalf("SetTabSource(thirdParty, nil) source = %q, want thirdParty", got)
		}

		// 本机登录（local）标签不得被单供应商第三方默认模型污染，且可正常设置 CLI 原生模型
		localTab := o.CreateTab(util.NewObj("backend", "claude", "source", "local", "activate", false))
		localID := str(localTab, "id")
		if ov := o.effectiveOverrides(o.tab(localID)); ov.model != nil {
			t.Fatalf("local tab without override got unexpected model %q", *ov.model)
		}
		updatedLocal := o.SetTabModel(localID, "claude-sonnet-4-6", "local")
		if str(updatedLocal, "modelOverride") != "claude-sonnet-4-6" {
			t.Fatalf("local SetTabModel got %v, want claude-sonnet-4-6", updatedLocal.Get("modelOverride"))
		}

		// 新增第二家供应商后，未显式绑定时不应擅自挑选默认模型
		gw.models = append(gw.models, ports.GatewayModel{
			Ref: "deep/ds-v4", Provider: "DeepSeek", Label: "ds-v4",
		})
		if m := o.defaultThirdPartyModel("gemini"); m != nil {
			t.Fatalf("multi-provider defaultThirdPartyModel = %q, want nil", *m)
		}
	})
}
