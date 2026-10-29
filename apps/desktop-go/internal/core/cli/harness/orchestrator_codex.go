package harness

// STUB（b7o 填充）：Node Orchestrator.ts 4065–4462。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// codexLiveSession = CodexLiveSession（字段 b7o 自定；turn 供 cancelTab 判空）。
type codexLiveSession struct {
	turn *codexTurn
}

type codexTurn struct{}

// CodexTurnRef = runCodexTurn 的 onTurn 回调参数。
type CodexTurnRef struct{ SessionID, TurnID string }

// runCodexTurn(tab, prompt, signal, staged=[], onTurn?)；staged 为 StagedImage（AbsPath 已填）。
func (o *Orchestrator) runCodexTurn(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, staged []cli.NormalizedImage, onTurn func(CodexTurnRef)) *jsrt.Promise[*util.Obj] {
	panic("orchestrator: runCodexTurn not ported yet (b7o)")
}

func (o *Orchestrator) interruptCodexTurn(id string, live *codexLiveSession, turn *codexTurn) {
	panic("orchestrator: interruptCodexTurn not ported yet (b7o)")
}

func (o *Orchestrator) teardownCodexLive(tabID string) {
	panic("orchestrator: teardownCodexLive not ported yet (b7o)")
}
