package harness

// STUB（b7o 填充）：Node Orchestrator.ts 4463–4683（dsh / grok / spawnCollect）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func (o *Orchestrator) runDsh(tab *util.Obj, prompt string) *jsrt.Promise[*util.Obj] {
	panic("orchestrator: runDsh not ported yet (b7o)")
}

func (o *Orchestrator) runGrokTurn(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, images []cli.NormalizedImage) *jsrt.Promise[*util.Obj] {
	panic("orchestrator: runGrokTurn not ported yet (b7o)")
}

// promptImageDir（Node 4515）。
func (o *Orchestrator) promptImageDir(tabID string) string {
	panic("orchestrator: promptImageDir not ported yet (b7o)")
}
