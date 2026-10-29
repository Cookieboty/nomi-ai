package cli

// b7s_ports.go：把 b7s 实现接到 ports.go 的接口上（Orchestrator 侧只依赖 ports）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// ModelDiscoveryPaths = Orchestrator.modelCatalog 传给 discoverModels 的路径部分
// （claudeDefaults / codexConfigPath / grok*CachePath）。ports.ModelDiscoveryDeps 只带 spawn/timeoutMs，
// 因此由 Orchestrator 在构造适配器时提供 Paths 回调（按 backend 每次调用求值，同 Node 每次现算）。
type ModelDiscoveryPaths struct {
	ClaudeDefaults        *ClaudeDefaults
	CodexConfigPath       string
	GrokModelsCachePath   string
	GrokSettingsCachePath string
}

// ModelDiscoveryAdapter 实现 ports.ModelDiscovery。
type ModelDiscoveryAdapter struct {
	Paths func(backend string) ModelDiscoveryPaths
}

var _ ports.ModelDiscovery = ModelDiscoveryAdapter{}

func (a ModelDiscoveryAdapter) DiscoverModels(backend string, d ports.ModelDiscoveryDeps) *jsrt.Promise[*util.Obj] {
	var p ModelDiscoveryPaths
	if a.Paths != nil {
		p = a.Paths(backend)
	}
	var spawnErr error
	deps := ModelDiscoveryDeps{
		Spawn: func(b string, args []string) clisdk.ChildLike {
			c, err := d.Spawn(b, args)
			if err != nil {
				spawnErr = err
				return nil
			}
			return c
		},
		ClaudeDefaults:        p.ClaudeDefaults,
		CodexConfigPath:       p.CodexConfigPath,
		GrokModelsCachePath:   p.GrokModelsCachePath,
		GrokSettingsCachePath: p.GrokSettingsCachePath,
	}
	if d.TimeoutMs != nil {
		ms := int(*d.TimeoutMs)
		deps.TimeoutMs = &ms
	}
	pr := DiscoverModels(backend, deps)
	if spawnErr != nil {
		// spawnHarness 同步抛错 → discoverModels 同步抛出；Go 侧以 rejection 交付（D-B7-S-1）
		return jsrt.Rejected[*util.Obj](spawnErr)
	}
	return pr
}

// GeminiTrustAdapter 实现 ports.GeminiTrust。
type GeminiTrustAdapter struct{}

var _ ports.GeminiTrust = GeminiTrustAdapter{}

func (GeminiTrustAdapter) AcpTimeoutMessage(method string, timeoutMs int) string {
	return gemini.AcpTimeoutMessage(method, timeoutMs)
}
func (GeminiTrustAdapter) NewAcpConnection(child clisdk.ChildLike, h rpc.Handlers) *rpc.Connection {
	return gemini.NewAcpConnection(child, h)
}
func (GeminiTrustAdapter) IsGeminiUntrustedExit(code *int, stderr string) bool {
	return gemini.IsGeminiUntrustedExit(code, stderr)
}
func (GeminiTrustAdapter) UntrustedError(folder string, cause error) error {
	return gemini.NewUntrustedError(folder, cause)
}
func (GeminiTrustAdapter) IsBroadGeminiFolder(folder, home string, extra []string, platform string) bool {
	return gemini.IsBroadGeminiFolder(folder, home, extra, platform)
}
func (GeminiTrustAdapter) TrustGeminiFolder(folder, home string, env *util.Obj, platform string) (*ports.GeminiTrustResult, error) {
	r, err := gemini.TrustGeminiFolder(folder, home, env, platform)
	if err != nil {
		return nil, err
	}
	return &ports.GeminiTrustResult{Folder: r.Folder, File: r.File, Previous: r.Previous}, nil
}
