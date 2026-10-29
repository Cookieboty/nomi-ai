package harness

// STUB（b7o 填充）：Node Orchestrator.ts 2913–3290、3701–3801、4016–4064。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// claudeLiveSession = ClaudeLiveSession。b7 只读 bgTasks / turn；其余字段 b7o 自定。
type claudeLiveSession struct {
	bgTasks map[string]bool
	turn    *claudeTurnWaiter
}

// claudeTurnWaiter = ClaudeTurnWaiter。
type claudeTurnWaiter struct{}

// runClaude(tab, prompt, signal?, images?, uuid?)；uuid "" = undefined。
func (o *Orchestrator) runClaude(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, images []cli.NormalizedImage, uuid string) *jsrt.Promise[*util.Obj] {
	panic("orchestrator: runClaude not ported yet (b7o)")
}

// interruptClaudeTurn（Node 2492，b7o 负责，因依赖 live 内部）。
func (o *Orchestrator) interruptClaudeTurn(id string, live *claudeLiveSession, turn *claudeTurnWaiter) {
	panic("orchestrator: interruptClaudeTurn not ported yet (b7o)")
}

// teardownClaudeLive：同时拆 ACP / Codex（Node 4025）。
func (o *Orchestrator) teardownClaudeLive(tabID string) {
	panic("orchestrator: teardownClaudeLive not ported yet (b7o)")
}

// dropRecycledClaude（Node 4016）。
func (o *Orchestrator) dropRecycledClaude(tabID string, live *claudeLiveSession) {
	panic("orchestrator: dropRecycledClaude not ported yet (b7o)")
}

// syncClaudeModel（Node 2969），setTab* 调用。
func (o *Orchestrator) syncClaudeModel(tab *util.Obj) *jsrt.Promise[struct{}] {
	panic("orchestrator: syncClaudeModel not ported yet (b7o)")
}

// requestClaudeControl（Node 3195），权限模式切换用。
func (o *Orchestrator) requestClaudeControl(live *claudeLiveSession, request *util.Obj) *jsrt.Promise[*util.Obj] {
	panic("orchestrator: requestClaudeControl not ported yet (b7o)")
}
