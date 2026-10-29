// Package gemini mirrors packages/core/src/cli/gemini（acp.ts / trust.ts / trustedFolders.ts）。
package gemini

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// AcpTimeoutMessage = acpTimeoutMessage（Math.round(timeoutMs/1000)）。
func AcpTimeoutMessage(_ string, timeoutMs int) string {
	return i18n.T("electron.common.gemini-did-not-respond-for-seconds-so-the", jsRound(float64(timeoutMs)/1000))
}

// jsRound = Math.round（.5 向 +∞）。
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// NewAcpConnection = new AcpConnection(child, handlers)。
func NewAcpConnection(child clisdk.ChildLike, h rpc.Handlers) *rpc.Connection {
	return rpc.NewConnection(child, h, rpc.ConnectionOptions{TimeoutMessage: AcpTimeoutMessage})
}
