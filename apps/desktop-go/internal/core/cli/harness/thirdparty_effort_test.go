package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 第三方模型的编程助手标签：思考深度与 Nomi 对话同一套（网关按模型能力给档位，off 不给选，默认第二档），
// 档位登记在网关的标签绑定上，由网关写进上游请求。

type effortGateway struct {
	models  []ports.GatewayModel
	updates []string // "model|effort"
}

func (g *effortGateway) Defaults(string) ports.GatewayDefaults {
	m := "maas/deepseek-v4.1-flash"
	return ports.GatewayDefaults{Source: "thirdParty", Model: &m}
}
func (g *effortGateway) Launch(string, string, string, *ports.GatewayLaunchOpts) *ports.GatewayLaunch {
	return nil
}
func (g *effortGateway) OfficialEnv(env *util.Obj) *util.Obj { return env }
func (g *effortGateway) Models() []ports.GatewayModel        { return g.models }
func (g *effortGateway) ReleaseAgent(string, string)         {}
func (g *effortGateway) ReleaseTab(string, string, *float64) {}
func (g *effortGateway) LaunchForTab(string, string, string, *string, *bool) *jsrt.Promise[*ports.GatewayTabLaunch] {
	return jsrt.Async(func() (*ports.GatewayTabLaunch, error) { return nil, nil })
}
func (g *effortGateway) UpdateTab(_, _, model string, effort *string) *jsrt.Promise[bool] {
	e := ""
	if effort != nil {
		e = *effort
	}
	g.updates = append(g.updates, model+"|"+e)
	return jsrt.Async(func() (bool, error) { return true, nil })
}

func effortTestOrch(t *testing.T) (*Orchestrator, *effortGateway) {
	t.Helper()
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	idle := 0.0
	gw := &effortGateway{models: []ports.GatewayModel{
		{Ref: "maas/deepseek-v4.1-flash", Provider: "MAAS", Label: "deepseek-v4.1-flash",
			Thinking: &ports.GatewayThinking{Levels: []string{"off", "low", "medium", "high"}, Default: "low"}},
		{Ref: "maas/grok-4.7", Provider: "MAAS", Label: "grok-4.7",
			Thinking: &ports.GatewayThinking{Levels: []string{"low", "medium", "high"}, Default: "medium"}},
		// 只有开 / 关的模型：去掉 off 后不到两档 = 不能调
		{Ref: "maas/glm-5.3", Provider: "MAAS", Label: "glm-5.3",
			Thinking: &ports.GatewayThinking{Levels: []string{"off", "on"}, Default: "on"}},
		{Ref: "maas/plain", Provider: "MAAS", Label: "plain"},
	}}
	o := New(Deps{
		Root:             filepath.Join(tmp, "harness"),
		Home:             tmp,
		DefaultCwd:       filepath.Join(tmp, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		Gateway:          gw,
	})
	return o, gw
}

func bindEffortOf(o *Orchestrator, id string) string {
	return derefStr(jsrt.Call(func() overrides { return o.effectiveOverrides(o.tab(id)) }).bindEffort)
}

func TestThirdPartyTabEffortFollowsGatewayCapabilities(t *testing.T) {
	o, gw := effortTestOrch(t)
	defer jsrt.Run(o.Dispose)
	tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", "codex", "source", "thirdParty")) })
	id := str(tab, "id")
	if s := jsrt.Call(func() string { return o.sourceOf(o.tab(id)) }); s != "thirdParty" {
		t.Fatalf("source=%s", s)
	}
	jsrt.Run(func() { o.SetTabModel(id, "maas/deepseek-v4.1-flash", "thirdParty") })
	// 没选过：发模型的默认档（界面上显示的也是它）
	if got := bindEffortOf(o, id); got != "low" {
		t.Fatalf("default bind effort=%q want low", got)
	}
	jsrt.Run(func() { o.SetTabReasoningEffort(id, "high") })
	if got := str(o.tab(id), "reasoningEffort"); got != "high" {
		t.Fatalf("stored=%q", got)
	}
	ov := jsrt.Call(func() overrides { return o.effectiveOverrides(o.tab(id)) })
	if derefStr(ov.bindEffort) != "high" || ov.effort != nil {
		t.Fatalf("bindEffort=%q effort=%v: third-party effort must go to the gateway binding, not CLI args", derefStr(ov.bindEffort), ov.effort)
	}
	// 不在这个模型档位里的、以及「不思考」都不给选
	for _, bad := range []string{"xhigh", "off"} {
		err := jsrt.Call(func() (msg string) {
			defer func() {
				if r := recover(); r != nil {
					msg = "thrown"
				}
			}()
			o.SetTabReasoningEffort(id, bad)
			return ""
		})
		if err == "" {
			t.Fatalf("level %q should be rejected", bad)
		}
	}
	// 换到同样支持 high 的模型：档位留着
	jsrt.Run(func() { o.SetTabModel(id, "maas/grok-4.7", "thirdParty") })
	if got := bindEffortOf(o, id); got != "high" {
		t.Fatalf("after switching to grok bind=%q want high", got)
	}
	// 换到不能调的模型：不发档位
	jsrt.Run(func() { o.SetTabModel(id, "maas/glm-5.3", "thirdParty") })
	if got := bindEffortOf(o, id); got != "" {
		t.Fatalf("toggle-only model bind=%q want none", got)
	}
	jsrt.Run(func() { o.SetTabModel(id, "maas/plain", "thirdParty") })
	if got := bindEffortOf(o, id); got != "" {
		t.Fatalf("plain model bind=%q want none", got)
	}

	// 已经跑着（绑定已登记）时改档位：立刻更新绑定，不等重启
	jsrt.Run(func() { o.SetTabModel(id, "maas/grok-4.7", "thirdParty") })
	jsrt.Run(func() {
		o.tabBindings[id] = &tabBinding{generation: 1, model: "maas/grok-4.7", effort: "medium"}
	})
	jsrt.Run(func() { o.SetTabReasoningEffort(id, "low") })
	jsrt.Run(func() {}) // 让 pushTabEffort 的异步更新跑完
	if len(gw.updates) == 0 || gw.updates[len(gw.updates)-1] != "maas/grok-4.7|low" {
		t.Fatalf("binding updates=%v want last maas/grok-4.7|low", gw.updates)
	}
	// 恢复默认：绑定回到模型默认档
	jsrt.Run(func() { o.SetTabReasoningEffort(id, nil) })
	jsrt.Run(func() {})
	if last := gw.updates[len(gw.updates)-1]; !strings.HasSuffix(last, "|medium") {
		t.Fatalf("restore default: last update %q want medium", last)
	}
}
