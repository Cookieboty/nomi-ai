package harness

// STUB（b7o 填充）：Node Orchestrator.ts 3291–3700。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// acpLiveSession = AcpLiveSession（字段 b7o 自定）。
type acpLiveSession struct{}

func (o *Orchestrator) runAcp(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, images []cli.NormalizedImage) *jsrt.Promise[*util.Obj] {
	panic("orchestrator: runAcp not ported yet (b7o)")
}

func (o *Orchestrator) cancelAcpTurn(live *acpLiveSession) {
	panic("orchestrator: cancelAcpTurn not ported yet (b7o)")
}

func (o *Orchestrator) teardownAcpLive(tabID string) {
	panic("orchestrator: teardownAcpLive not ported yet (b7o)")
}
