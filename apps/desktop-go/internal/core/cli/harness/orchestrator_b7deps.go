package harness

// STUB（b7 填充）：b7o 的长驻会话代码（orchestrator_claude/acp/codex/dsh_grok.go）调用、归 b7 所有的方法。
// 签名约定同 orchestrator_live.go；b7 移植时直接在这里填实现（或搬到各自文件并删掉这里的同名桩）。
// 桩一律 panic(b7Stub)，b7o 的 golden 测试遇到它跳过（见 orchestrator_live_parity_test.go）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// b7Stub：未移植的 b7 方法 panic 的值。
type b7Stub string

func notPortedB7(name string) { panic(b7Stub("orchestrator: " + name + " not ported yet (b7)")) }

func (o *Orchestrator) emitEvent(tabID string, ev *util.Obj) { notPortedB7("emitEvent") }
func (o *Orchestrator) startIdleSweep()                      { notPortedB7("startIdleSweep") }
func (o *Orchestrator) stopIdleSweep()                       { notPortedB7("stopIdleSweep") }
func (o *Orchestrator) clearBackgroundAgents(tabID string)   { notPortedB7("clearBackgroundAgents") }
func (o *Orchestrator) finish(tab *util.Obj, ok bool, text string, errMsg *string) {
	notPortedB7("finish")
}

// SendTab：sendTab 移植前的桩。
func (o *Orchestrator) SendTab(id, prompt string, images []any, userInitiated bool) *jsrt.Promise[*util.Obj] {
	notPortedB7("sendTab")
	return nil
}
