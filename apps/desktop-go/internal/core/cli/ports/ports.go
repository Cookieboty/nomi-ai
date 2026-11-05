// Package ports 定义 Orchestrator（core/cli/harness）向 core/cli 各服务
// 要的接口。服务侧实现这些接口（core/cli/b7s_ports.go）；Orchestrator 只依赖接口并用 fakes 测试。接线点在 app 层（hostports_wiring.go）。
//
// 归属约定：
//   - harness：Orchestrator、liveTypes、permissionQueue、spawn、promptImages、generatedImages、
//     transcriptContext、gitOps、slashDiscovery、workspaceFiles、permissionMode、modelCatalog、
//     externalPlugins 存储、各 harness 处理器与 mock-CLI 往返测试。
//   - core/cli 及子包：CliUpdate、SessionHistory、Account(+keychain/adapters/homes/identity/login)、Delegate、
//     CliPluginHost、codexThreadIndex/state_5.sqlite、cliplugins、acpProbe/launch/
//     external/manifest/models、modelDiscovery、gemini/{acp,trust,trustedFolders}。
package ports

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// HarnessTabSource / HarnessBackend 的字符串取值。
type (
	HarnessTabSource = string
	BuiltinCliId     = string
	AccountBackend   = string
)

// GatewayDefaults = HarnessGateway.defaults 的返回（Model/AccountId nil = null）。
type GatewayDefaults struct {
	Source    HarnessTabSource
	Model     *string
	AccountId *string
}

// GatewayLaunchOpts：LongContext nil = 缺省（不带该键）。
type GatewayLaunchOpts struct {
	TabBound    bool
	LongContext *bool
}

// GatewayLaunch：ModelInConfig nil = 缺省（undefined）。
type GatewayLaunch struct {
	Env           *util.Obj
	Args          []string
	Strip         []string
	ModelInConfig *bool
}

type GatewayTabLaunch struct {
	Env           *util.Obj
	Generation    float64
	ModelInConfig *bool
}

type GatewayModel struct {
	Ref, Provider, Label string
	Vision               *bool
}

// HarnessGateway：编排器用的网关端口。可选方法用 HasTabAPI 判断（相当于 `?.`）。
type HarnessGateway interface {
	Defaults(kind BuiltinCliId) GatewayDefaults
	Launch(kind BuiltinCliId, tabId, model string, opts *GatewayLaunchOpts) *GatewayLaunch // nil = null
	OfficialEnv(env *util.Obj) *util.Obj
	Models() []GatewayModel
	ReleaseAgent(kind BuiltinCliId, tabId string)
}

// HarnessGatewayTabs = launchForTab/releaseTab/updateTab 三个可选方法；网关实现了才断言成功。
type HarnessGatewayTabs interface {
	LaunchForTab(kind BuiltinCliId, tabId, model string, effort *string, longContext *bool) *jsrt.Promise[*GatewayTabLaunch]
	ReleaseTab(kind BuiltinCliId, tabId string, generation *float64)
	UpdateTab(kind BuiltinCliId, tabId, model string, effort *string) *jsrt.Promise[bool]
}

type AccountLaunch struct {
	Env   *util.Obj
	Strip []string
	Args  []string
	Sig   string
}

// HarnessOfficialAccounts：官方账号端口（accountId nil = null/undefined）。
type HarnessOfficialAccounts interface {
	Launch(kind AccountBackend, accountId *string) AccountLaunch
}

// AccountSessionNoter = 可选的 noteSession。
type AccountSessionNoter interface {
	NoteSession(kind AccountBackend, sessionId string, accountId *string)
}

// HarnessExternalPlugins：外部插件端口（Spec nil = undefined）。
type HarnessExternalPlugins interface {
	Spec(id string) *util.Obj
}

type ExternalHandshaker interface {
	Handshake(id string, images, resume bool)
}

// ---- 模型发现 ----

type ModelDiscoveryDeps struct {
	Spawn     func(backend string, args []string) (clisdk.ChildLike, error)
	TimeoutMs *float64
}

// ModelDiscovery = discoverModels；结果为 BackendModelCatalog 的 JSON 形状（*util.Obj）。
type ModelDiscovery interface {
	DiscoverModels(backend string, deps ModelDiscoveryDeps) *jsrt.Promise[*util.Obj]
}

// ---- gemini（acp / trust / trustedFolders） ----

type GeminiTrustResult struct {
	Folder   string
	File     string
	Previous *string
}

type GeminiTrust interface {
	AcpTimeoutMessage(method string, timeoutMs int) string
	NewAcpConnection(child clisdk.ChildLike, h rpc.Handlers) *rpc.Connection
	IsGeminiUntrustedExit(exitCode *int, stderr string) bool
	// UntrustedError 构造 GeminiUntrustedError（Name() == "GeminiUntrustedError"）。
	UntrustedError(folder string, cause error) error
	IsBroadGeminiFolder(folder, home string, extra []string, platform string) bool
	// TrustGeminiFolder 阻塞；Orchestrator 在 jsrt 外调用。
	TrustGeminiFolder(folder string, home string, env *util.Obj, platform string) (*GeminiTrustResult, error)
}

// ---- 会话模型 / 历史（SessionHistoryService）只读回调 ----

// QualitySink = d.quality。
type QualitySink interface {
	AddCli(record *util.Obj)
}
