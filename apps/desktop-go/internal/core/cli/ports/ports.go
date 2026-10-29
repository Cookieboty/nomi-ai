// Package ports 定义 Orchestrator（feat/2.0.5-go-b7）向独立 core/cli 服务（feat/2.0.5-go-b7s）
// 要的接口。b7s 实现这些接口；b7 只依赖接口并用 fakes 测试。接线点在 app 层（hostports_wiring.go）。
//
// 归属约定：
//   - b7：Orchestrator、liveTypes、permissionQueue、spawn、promptImages、generatedImages、
//     transcriptContext、gitOps、slashDiscovery、workspaceFiles、permissionMode、modelCatalog、
//     externalPlugins 存储、各 harness 处理器与 mock-CLI 往返 golden。
//   - b7s：CliUpdate、SessionHistory、Account(+keychain/adapters/homes/identity/login)、Delegate、
//     CliPluginHost、codexThreadIndex/state_5.sqlite、cli-plugins 余下部分、acpProbe/launch/
//     external/manifest/models、modelDiscovery、gemini/{acp,trust,trustedFolders}。
package ports

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// HarnessTabSource / HarnessBackend 与 Node types.ts 相同的字符串取值。
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

// GatewayLaunchOpts：LongContext nil = 缺省（Node 不带该键）。
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

// HarnessGateway mirrors liveTypes.HarnessGateway。可选方法用 HasTabAPI 判断（Node 的 `?.`）。
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

// HarnessOfficialAccounts mirrors liveTypes.HarnessOfficialAccounts（accountId nil = null/undefined）。
type HarnessOfficialAccounts interface {
	Launch(kind AccountBackend, accountId *string) AccountLaunch
}

// AccountSessionNoter = 可选的 noteSession。
type AccountSessionNoter interface {
	NoteSession(kind AccountBackend, sessionId string, accountId *string)
}

// HarnessExternalPlugins mirrors liveTypes.HarnessExternalPlugins（Spec nil = undefined）。
type HarnessExternalPlugins interface {
	Spec(id string) *util.Obj
}

type ExternalHandshaker interface {
	Handshake(id string, images, resume bool)
}

// ---- 模型发现（modelDiscovery.ts，b7s） ----

type ModelDiscoveryDeps struct {
	Spawn     func(backend string, args []string) (clisdk.ChildLike, error)
	TimeoutMs *float64
}

// ModelDiscovery = discoverModels；结果为 BackendModelCatalog 的 JSON 形状（*util.Obj）。
type ModelDiscovery interface {
	DiscoverModels(backend string, deps ModelDiscoveryDeps) *jsrt.Promise[*util.Obj]
}

// ---- gemini（gemini/{acp,trust,trustedFolders}.ts，b7s） ----

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

// ---- 会话模型 / 历史（SessionHistoryService，b7s）只读回调 ----

// QualitySink = d.quality。
type QualitySink interface {
	AddCli(record *util.Obj)
}
