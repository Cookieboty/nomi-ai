package harness

// STUB（b7 填充）：b7o 的长驻会话代码（orchestrator_claude/acp/codex/dsh_grok.go）调用、归 b7 所有的方法。
// 签名约定同 orchestrator_live.go；b7 移植时直接在这里填实现（或搬到各自文件并删掉这里的同名桩）。
// 桩一律 panic(b7Stub)，b7o 的 golden 测试遇到它跳过（见 orchestrator_live_parity_test.go）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// b7Stub：未移植的 b7 方法 panic 的值。
type b7Stub string

func notPortedB7(name string) { panic(b7Stub("orchestrator: " + name + " not ported yet (b7)")) }

// tabLaunch = TabLaunch（一次启动的来源注入，见 launchFor）。
type tabLaunch struct {
	env           *util.Obj // Record<string,string>
	args          []string
	strip         []string
	official      bool
	modelInConfig bool
	sig           string
	modelSig      string
}

// officialLaunch = OFFICIAL_LAUNCH。
var officialLaunch = &tabLaunch{env: util.NewObj(), args: []string{}, strip: []string{}, official: true, sig: "official"}

// overrides = effectiveOverrides 的返回（nil = null）。
type overrides struct{ model, effort *string }

func (o *Orchestrator) effectiveOverrides(tab *util.Obj) overrides {
	notPortedB7("effectiveOverrides")
	return overrides{}
}

// launchFor 可能 throw（panic jsrt.JSThrow）。
func (o *Orchestrator) launchFor(tab *util.Obj) *tabLaunch { notPortedB7("launchFor"); return nil }
func (o *Orchestrator) needsTabBinding(tab *util.Obj) bool {
	notPortedB7("needsTabBinding")
	return false
}
func (o *Orchestrator) bindTabLaunch(tab *util.Obj, l *tabLaunch) *jsrt.Promise[*tabLaunch] {
	notPortedB7("bindTabLaunch")
	return nil
}
func (o *Orchestrator) dropTabBinding(tab *util.Obj) { notPortedB7("dropTabBinding") }
func (o *Orchestrator) syncTabBinding(tab *util.Obj) *jsrt.Promise[struct{}] {
	notPortedB7("syncTabBinding")
	return nil
}
func (o *Orchestrator) watchTabRelease(tab *util.Obj, child clisdk.ChildLike) {
	notPortedB7("watchTabRelease")
}

// childEnv(useNode, l, extra?)；extra nil = {}。
func (o *Orchestrator) childEnv(useNode bool, l *tabLaunch, extra *util.Obj) *util.Obj {
	notPortedB7("childEnv")
	return nil
}
func (o *Orchestrator) emitEvent(tabID string, ev *util.Obj) { notPortedB7("emitEvent") }
func (o *Orchestrator) armPermissionTimeout(tabID, requestID string) {
	notPortedB7("armPermissionTimeout")
}
func (o *Orchestrator) allowIfBypass(tabID, requestID string, notify func()) {
	notPortedB7("allowIfBypass")
}
func (o *Orchestrator) applyCliPermissionMode(tabID, raw string) {
	notPortedB7("applyCliPermissionMode")
}
func (o *Orchestrator) permissionTimeoutMs(tabID string) float64 {
	notPortedB7("permissionTimeoutMs")
	return 0
}
func (o *Orchestrator) clearPermissionTimeouts(tabID string) { notPortedB7("clearPermissionTimeouts") }
func (o *Orchestrator) startIdleSweep()                      { notPortedB7("startIdleSweep") }
func (o *Orchestrator) stopIdleSweep()                       { notPortedB7("stopIdleSweep") }
func (o *Orchestrator) clearBackgroundAgents(tabID string)   { notPortedB7("clearBackgroundAgents") }
func (o *Orchestrator) bindCliSession(tab *util.Obj, sessionID string) {
	notPortedB7("bindCliSession")
}

// turnModelResolver(tab)(events, usage)；返回 nil = undefined；usage nil = undefined。
func (o *Orchestrator) turnModelResolver(tab *util.Obj) func(events []*util.Obj, usage *util.Obj) any {
	notPortedB7("turnModelResolver")
	return nil
}

// finish(tab, ok, text, error?)；errMsg nil = undefined。
func (o *Orchestrator) finish(tab *util.Obj, ok bool, text string, errMsg *string) {
	notPortedB7("finish")
}
func (o *Orchestrator) switchAcpMode(id string, gl *acpLiveSession, mode string) {
	notPortedB7("switchAcpMode")
}
func (o *Orchestrator) sourceOf(tab *util.Obj) string { notPortedB7("sourceOf"); return "" }

// cachedCatalog：nil = null。
func (o *Orchestrator) cachedCatalog(backend string) *util.Obj {
	notPortedB7("cachedCatalog")
	return nil
}

// externalSpecOf(id?)；id "" = undefined；可能 throw。
func (o *Orchestrator) externalSpecOf(id string) *util.Obj { notPortedB7("externalSpecOf"); return nil }
