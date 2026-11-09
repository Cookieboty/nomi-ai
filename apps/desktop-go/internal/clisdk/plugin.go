package clisdk

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// plugin.go —— 编程助手插件契约（docs/development/coding-agents.md）。
// 可选方法 = nil 函数字段；Record<string,string> = 保序 *util.Obj（值为 string）；
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

// LaunchFile：启动前要写的文件；Path 是相对路径时相对会话目录（RunDir / 私有主目录）
type LaunchFile struct {
	Path, Content string
	Mode          *int
}

// PrivateHome：给这个会话一个私有主目录（EnvVar 指向 RunDir）：Shared 里的条目软链进来（Shared 空 = CLI 自己的
// 用户主目录），名字匹配 KeepPrivate（正则）的不链（配置、凭据），由 Files 写私有的
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
	Reasoning                *bool
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

// HistoryFileRef：一份会话记录文件（DirID "" = 无）。
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
	// UserHome：没有指定账号目录时 CLI 用的主目录（HomeEnv 指向的目录）；nil = 内核里按 CLI 的老逻辑
	UserHome func(env Env, home string) string
	// SignedIn：主目录 root 里有没有登录（读凭据文件）；nil = 内核里按 CLI 的老逻辑
	SignedIn func(root string) bool
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
