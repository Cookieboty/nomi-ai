package clisdk

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// plugin.go —— packages/cli-sdk/src/plugin.ts 的 Go 形状。
// TS 可选方法 = nil 函数字段；Record<string,string> = 保序 *util.Obj（值为 string）；
// string | null = "" 与 Has 标志按字段注明。

// Env 是 NodeJS.ProcessEnv（无序查找表）。
type Env = map[string]string

type CliMainHost struct {
	Logger interface {
		Info(string, any)
		Warn(string, any)
	}
	DataDir  string
	Home     string
	Env      Env
	Platform string
}

type LaunchFile struct {
	Path, Content string
	Mode          *int
}

type PrivateHome struct {
	EnvVar, Shared string
	KeepPrivate    []string
}

type AgentLaunch struct {
	Env         *util.Obj // Record<string,string>（保序）
	Args        []string
	Strip       []string
	Files       []LaunchFile // nil = 未给
	PrivateHome *PrivateHome
}

// LaunchContext：Model/Effort/AccountDir 为 nil = null。
type LaunchContext struct {
	Cwd            string
	PermissionMode string
	Model          *string
	Effort         *string
	AccountDir     *string
	RunDir         string
}

type ModelMeta struct {
	ContextWindow, MaxOutput *float64
	Images                   *bool
}

type ThirdPartyLaunchContext struct {
	LaunchContext
	GatewayURL string
	Token      string
	ModelMeta  *ModelMeta
}

type ModelArgsOpts struct{ Model, Effort *string }

type LaunchCapability struct {
	Official         func(ctx LaunchContext) AgentLaunch
	ThirdParty       func(ctx ThirdPartyLaunchContext) AgentLaunch // nil = 不支持
	PlaceholderModel string
	ModelArgs        func(o ModelArgsOpts) []string
}

type DetectCapability struct {
	ResolveBin func(env Env) *string
	Version    func(bin string) *string
}

type Command struct {
	Command string
	Args    []string
}

type UpdateCapability struct {
	Latest  func() *string
	Command func() *Command
}

type ExecRules struct {
	Completes         func(ev Ev) bool
	SilentExitIsError bool
}

type SessionCustomization struct {
	Args         func(ctx LaunchContext, resumeID *string) []string
	Parser       func() func(line string) []Ev
	MapEvent     func(e SessionEvent) SessionEvent // nil 返回 = null
	Exec         *ExecRules
	CreateDriver func(launch AgentLaunch, ctx LaunchContext) SessionDriver
}

type ModelCatalogCapability struct {
	List func(env Env) (*util.Obj, error)
}

type PermissionCapability struct {
	Supported  []string
	Launch     func(mode string, network *bool) (args []string, env *util.Obj)
	LaunchArgs func(mode string) []string
	ModeID     func(mode string) string
	FromModeID func(id string) string // "" = null
	PlanPrefix string
}

type HistoryCapability struct {
	Roots  func(env Env, home string) []string
	Scan   func(root string) []HistoryFileRef
	Parse  func(text string, f HistoryFileRef) *util.Obj
	Resume func(sessionID string) *util.Obj // {args?, loadSession?}
}

// HistoryFileRef mirrors plugin.ts HistoryFileRef（DirID "" = 无）。
type HistoryFileRef struct {
	Path  string
	Mtime float64
	Size  float64
	DirID string
}

type ProgressCapability struct {
	WatchRoots func(env Env, home string) []string
}

type UsageCapability struct {
	LogRoots func(env Env, home string) []string
	Quota    func(env Env) (any, error)
}

type SharedEntry struct {
	Name            string
	Dir             bool
	CreateIfMissing bool
}

type AccountCapability struct {
	HomeEnv     string
	Strip       []string
	Shared      []SharedEntry
	LoginArgs   []string
	LogoutArgs  []string // nil = 未给
	StatusArgs  []string
	AccountArgs []string
}

type SlashSource struct {
	Kind, Path, Scope string
	StrictInvocable   *bool
}

type SlashItem struct {
	Name, Description, Kind string
}

type SlashDiscoveryCapability struct {
	Sources func(projectChain []string, home string) []SlashSource
	List    func(cwd string, env Env, home string) ([]SlashItem, error)
}

type TerminalCapability struct {
	Command func(cwd string, resumeID *string, env *util.Obj) Command
}

type CliMainImpl struct {
	Detect      *DetectCapability
	Update      *UpdateCapability
	Launch      LaunchCapability
	Session     *SessionCustomization
	Models      *ModelCatalogCapability
	Permissions *PermissionCapability
	History     *HistoryCapability
	Progress    *ProgressCapability
	Usage       *UsageCapability
	Accounts    *AccountCapability
	Slash       *SlashDiscoveryCapability
	Terminal    *TerminalCapability
}

type CliPlugin struct {
	Manifest *util.Obj
	Main     func(host CliMainHost) (*CliMainImpl, error) // nil = 无主进程实现
}
