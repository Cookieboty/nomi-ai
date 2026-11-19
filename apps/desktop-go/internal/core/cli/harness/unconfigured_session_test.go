package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type dynamicUnconfiguredGateway struct {
	models      []ports.GatewayModel
	defaultRef  *string
	defaultSrc  string
	launchCalls []string
}

func (g *dynamicUnconfiguredGateway) Defaults(string) ports.GatewayDefaults {
	return ports.GatewayDefaults{Source: g.defaultSrc, Model: g.defaultRef}
}

func (g *dynamicUnconfiguredGateway) Launch(_, _, model string, _ *ports.GatewayLaunchOpts) *ports.GatewayLaunch {
	g.launchCalls = append(g.launchCalls, model)
	return &ports.GatewayLaunch{
		Env: util.NewObj("ANTHROPIC_BASE_URL", "http://127.0.0.1:1/anthropic", "ANTHROPIC_MODEL", model),
	}
}

func (g *dynamicUnconfiguredGateway) OfficialEnv(env *util.Obj) *util.Obj { return env }
func (g *dynamicUnconfiguredGateway) Models() []ports.GatewayModel        { return g.models }
func (g *dynamicUnconfiguredGateway) ReleaseAgent(string, string)         {}

type mutableAccounts struct {
	has         map[string]bool
	launchCalls []string
}

func (a *mutableAccounts) Launch(kind ports.AccountBackend, _ *string) ports.AccountLaunch {
	a.launchCalls = append(a.launchCalls, string(kind))
	return ports.AccountLaunch{Env: util.NewObj(), Strip: []string{}, Args: []string{}, Sig: "official:" + string(kind)}
}
func (a *mutableAccounts) HasAccount(kind ports.AccountBackend) bool         { return a.has[kind] }
func (a *mutableAccounts) HasSignedInAccount(kind ports.AccountBackend) bool { return a.has[kind] }

func newUnconfiguredTestOrch(t *testing.T, root, home string, gw *dynamicUnconfiguredGateway, acc *mutableAccounts) *Orchestrator {
	t.Helper()
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(home, 0o755)
	base := filepath.Dir(root)
	_ = os.MkdirAll(filepath.Join(base, "docs", "nomi"), 0o755)
	idle := 0.0
	return New(Deps{
		Root:             root,
		Home:             home,
		DefaultCwd:       filepath.Join(base, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(base, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		PrewarmClaude:    true,
		Gateway:          gw,
		Accounts:         acc,
	})
}

func TestMultiProviderWithoutDefaultEntersPendingStateAndSkipsPrewarmAndPreflight(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	gw := &dynamicUnconfiguredGateway{
		defaultSrc: "official",
		models: []ports.GatewayModel{
			{Ref: "p1/model-a", Provider: "P1", Label: "model-a"},
			{Ref: "p2/model-b", Provider: "P2", Label: "model-b"},
		},
	}
	acc := &mutableAccounts{has: map[string]bool{}}
	o := newUnconfiguredTestOrch(t, filepath.Join(tmp, "harness"), filepath.Join(tmp, "home"), gw, acc)
	defer jsrt.Run(o.Dispose)

	var tabID string
	jsrt.Run(func() {
		tab := o.CreateTab(util.NewObj("backend", "claude"))
		tabID = str(tab, "id")
		if got := o.sourceOf(tab); got != "thirdParty" {
			t.Fatalf("source = %q, want thirdParty", got)
		}
		if trimOrNil(tab.Get("modelOverride")) != nil {
			t.Fatalf("modelOverride = %v, want nil (pending pick)", tab.Get("modelOverride"))
		}
		if len(gw.launchCalls) != 0 || len(acc.launchCalls) != 0 || len(o.live.claude) != 0 {
			t.Fatalf("unready tab must not prewarm: gw=%v acc=%v live=%d", gw.launchCalls, acc.launchCalls, len(o.live.claude))
		}
	})

	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.SendTab(tabID, "hello world", nil, true)
	})
	if _, err := jsrt.Block(p); err == nil {
		t.Fatal("SendTab on unconfigured pending tab must fail preflight")
	}

	jsrt.Run(func() {
		if msgs := o.TabMessages(tabID); len(msgs) != 0 {
			t.Fatalf("preflight failure must not append messages, got %d", len(msgs))
		}
		tab := o.tab(tabID)
		if got := str(tab, "status"); got != "idle" {
			t.Fatalf("preflight failure status = %q, want idle", got)
		}
		if truthy(tab.Get("lastError")) {
			t.Fatalf("preflight failure must not set lastError, got %v", tab.Get("lastError"))
		}
	})
}

func TestSetTabSourceAllowsPendingThirdPartyAndClearsDeletedScopeModel(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	gw := &dynamicUnconfiguredGateway{
		defaultSrc: "official",
		models: []ports.GatewayModel{
			{Ref: "p1/model-a", Provider: "P1", Label: "model-a"},
			{Ref: "p2/model-b", Provider: "P2", Label: "model-b"},
		},
	}
	acc := &mutableAccounts{has: map[string]bool{"claude": true}}
	o := newUnconfiguredTestOrch(t, filepath.Join(tmp, "harness"), filepath.Join(tmp, "home"), gw, acc)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		tab := o.CreateTab(util.NewObj("backend", "claude", "source", "thirdParty", "modelOverride", "p1/model-a", "activate", false))
		id := str(tab, "id")
		// 切回官方账号（把 p1/model-a 留在 thirdParty scope 的 modelByScope 里）
		o.SetTabSource(id, "official", nil)
		// 删除 p1/model-a（仍保留多家供应商，只是换了个模型）
		gw.models = []ports.GatewayModel{
			{Ref: "p1/model-c", Provider: "P1", Label: "model-c"},
			{Ref: "p2/model-b", Provider: "P2", Label: "model-b"},
		}
		// 不指定具体模型直接切入第三方待选态：应当放行，并且清掉失效的旧模型覆盖
		res := o.SetTabSource(id, "thirdParty", nil)
		if o.sourceOf(res) != "thirdParty" {
			t.Fatalf("SetTabSource(thirdParty, nil) source = %q, want thirdParty", o.sourceOf(res))
		}
		if trimOrNil(res.Get("modelOverride")) != nil {
			t.Fatalf("deleted scope model must be cleared, got %v", res.Get("modelOverride"))
		}
	})
}

func TestModelCatalogForFastFailsWithoutLogin(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	gw := &dynamicUnconfiguredGateway{
		defaultSrc: "official",
		models:     []ports.GatewayModel{{Ref: "p1/model-a", Provider: "P1", Label: "model-a"}},
	}
	acc := &mutableAccounts{has: map[string]bool{}}
	o := newUnconfiguredTestOrch(t, filepath.Join(tmp, "harness"), filepath.Join(tmp, "home"), gw, acc)
	defer jsrt.Run(o.Dispose)

	offCat, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.ModelCatalogFor("claude", false, "official")
	}))
	if err != nil {
		t.Fatalf("official catalog error = %v, want structured catalog error", err)
	}
	if !truthy(offCat.Get("error")) {
		t.Fatalf("official catalog without signed-in account must report error, got %v", util.Stringify(offCat))
	}

	locCat, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.ModelCatalogFor("claude", false, "local")
	}))
	if err != nil {
		t.Fatalf("local catalog error = %v, want structured catalog error", err)
	}
	if !truthy(locCat.Get("error")) {
		t.Fatalf("local catalog without local login must report error, got %v", util.Stringify(locCat))
	}
}

func TestReconcileEmptyTabsBidirectional(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "harness")
	home := filepath.Join(tmp, "home")
	cwd := filepath.Join(tmp, "work")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(home, 0o755)
	_ = os.MkdirAll(cwd, 0o755)

	tabsJSON := `{"tabs":[` +
		`{"id":"empty-off","backend":"claude","source":"official","cwd":` + util.Stringify(cwd) + `,"title":"Claude Code"},` +
		`{"id":"stale-tp","backend":"claude","source":"thirdParty","modelOverride":"gone/m","cwd":` + util.Stringify(cwd) + `,"title":"Claude Code 2"},` +
		`{"id":"used-off","backend":"claude","source":"official","cliSessionId":"cli-1","cwd":` + util.Stringify(cwd) + `,"title":"Used"}` +
		`]}`
	if err := os.WriteFile(filepath.Join(root, "tabs.json"), []byte(tabsJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	gw := &dynamicUnconfiguredGateway{
		defaultSrc: "official",
		models: []ports.GatewayModel{
			{Ref: "p1/model-a", Provider: "P1", Label: "model-a"},
			{Ref: "p2/model-b", Provider: "P2", Label: "model-b"},
		},
	}
	acc := &mutableAccounts{has: map[string]bool{}}
	o := newUnconfiguredTestOrch(t, root, home, gw, acc)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		// 1) load() 后：空官方壳迁入 thirdParty 待选态；失效模型被清空；已说过话的标签保持不变
		emptyOff := o.tab("empty-off")
		if o.sourceOf(emptyOff) != "thirdParty" || trimOrNil(emptyOff.Get("modelOverride")) != nil {
			t.Fatalf("empty-off after load = (%q, %v), want (thirdParty, nil)", o.sourceOf(emptyOff), emptyOff.Get("modelOverride"))
		}
		staleTp := o.tab("stale-tp")
		if trimOrNil(staleTp.Get("modelOverride")) != nil {
			t.Fatalf("stale-tp modelOverride = %v, want nil", staleTp.Get("modelOverride"))
		}
		usedOff := o.tab("used-off")
		if o.sourceOf(usedOff) != "official" {
			t.Fatalf("non-empty used-off source = %q, want official", o.sourceOf(usedOff))
		}

		// 2) 从多供应商变为单供应商后触发 ReconcileEmptyTabs：待选空标签自动选中单供应商默认模型
		gw.models = []ports.GatewayModel{{Ref: "p1/model-a", Provider: "P1", Label: "model-a"}}
		o.ReconcileEmptyTabs()
		if got := str(o.tab("empty-off"), "modelOverride"); got != "p1/model-a" {
			t.Fatalf("single-provider reconcile modelOverride = %q, want p1/model-a", got)
		}

		// 3) 反向纠偏：清空三方模型且官方账号登录后，空 thirdParty 标签自动切回 official
		gw.models = nil
		acc.has["claude"] = true
		o.ReconcileEmptyTabs()
		if got := o.sourceOf(o.tab("empty-off")); got != "official" {
			t.Fatalf("reverse reconcile empty-off source = %q, want official", got)
		}
	})
}

func TestTransientEmptyTabsCleanedOnSwitchAndExcludedFromSnapshot(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	gw := &dynamicUnconfiguredGateway{
		defaultSrc: "official",
		models: []ports.GatewayModel{
			{Ref: "p1/model-a", Provider: "P1", Label: "model-a"},
			{Ref: "p2/model-b", Provider: "P2", Label: "model-b"},
		},
	}
	acc := &mutableAccounts{has: map[string]bool{}}
	o := newUnconfiguredTestOrch(t, filepath.Join(tmp, "harness"), filepath.Join(tmp, "home"), gw, acc)
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		empty1 := o.CreateTab(util.NewObj("backend", "claude"))
		id1 := str(empty1, "id")
		errored := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
		idErr := str(errored, "id")
		o.tab(idErr).Set("status", "error")
		o.tab(idErr).Set("lastError", "kept error")

		// tabsSnapshot 中过滤瞬态空标签 empty1，并把 activeTabId 回退到 main，但保留有错误记录的标签
		snap := o.tabsSnapshot()
		if got := str(snap, "activeTabId"); got != MainTabID {
			t.Fatalf("snapshot activeTabId = %q, want %q", got, MainTabID)
		}
		keptTabs, _ := snap.Get("tabs").([]any)
		if len(keptTabs) != 1 || str(keptTabs[0].(*util.Obj), "id") != idErr {
			t.Fatalf("snapshot tabs = %v, want only errored tab %q", util.Stringify(snap), idErr)
		}

		// 从瞬态空标签 id1 切走后，id1 被自动销毁；切走非空（errored）标签后再回 main 也不会误删它
		o.SetActiveTab(idErr)
		if o.tab(id1) != nil {
			t.Fatalf("switching away from transient empty tab %q must discard it", id1)
		}
		o.SetActiveTab(MainTabID)
		if o.tab(idErr) == nil {
			t.Fatalf("errored tab %q must be preserved on SetActiveTab", idErr)
		}
	})
}
