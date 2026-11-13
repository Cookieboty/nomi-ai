package desktop

// 后台任务的审批（docs/features/scheduling-calendar.md）：PermissionBroker 的 registerBackground /
// authorizeBackground。Go 用 context 携带：派生的 context（工具执行时拿到的）自然继承。

import (
	"context"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
)

// BackgroundRun：一次后台任务执行；Ask 让任务停到「等你批准」并阻塞到用户回答
type BackgroundRun struct {
	Level int
	Ask   func(tool, summary, detail string) bool
	// Connections：任务授权里的连接（docs/features/scheduling-calendar.md）；经连接的工具据此收窄
	Connections []ConnGrant
	// Tainted：这次执行读过外部内容（事件触发）：写入与命令都问人，不按审核放行（docs/features/scheduling-calendar.md）
	Tainted bool
	// External：对外动作的副作用日志（docs/features/scheduling-calendar.md）：对外工具执行前写 intent、成功后写 done；可为 nil
	External connections.ExternalJournal
	// Trusted：高级权限（派给 Nomi 的后台执行，docs/features/scheduling-calendar.md）：读过外部内容后的写入仍按写入策略放行、
	// 授权里的 MCP 对外工具直接跑；破坏性动作、凭据 / 永不放行的命令、审核不放行的命令照旧问人
	Trusted bool
	// AutoJudge：按风险自动判断（任务授权里用户主动开的，默认关；L3 及以上才生效）：命令交给已有的命令审核判定，
	// 放行就直接跑，只有高风险（破坏性、凭据 / 永不放行类、审核不放行、事件触发读过外部内容）才问人；不看「命令自动审核」开关
	AutoJudge bool
	// AutoAll：读前台的「全部自动」（nil = 关）；开着时后台的写入与命令不再逐项问人，
	// 但凭据 / 永不放行类、高风险命令、破坏性动作、读过外部内容后的操作照旧问人
	AutoAll func() bool
	// Paths：任务授权的文件夹：文件工具的路径（realpath 后）还必须落在其中之一（#231）。
	// nil = 不额外收窄（高级权限的委派执行）；空切片 = 不许碰任何文件
	Paths []string
	// Live：任务「当前」的授权（运行中收窄立即生效，#232）；nil 时用上面的快照。
	// ok=false：任务已换代 / 撤销 / 不在跑，一律不放行
	Live func() (g LiveGrant, ok bool)
}

// LiveGrant：任务当前的授权
type LiveGrant struct {
	Level       int
	Connections []ConnGrant
	Paths       []string
	// AutoJudge：任务当前授权里的「按风险自动判断」开关
	AutoJudge bool
}

// level / conns / paths：读任务当前授权（有 Live 时），否则用登记时的快照
func (r *BackgroundRun) level() int {
	if r.Live == nil {
		return r.Level
	}
	if g, ok := r.Live(); ok {
		return g.Level
	}
	return 0
}

func (r *BackgroundRun) conns() []ConnGrant {
	if r.Live == nil {
		return r.Connections
	}
	if g, ok := r.Live(); ok {
		return g.Connections
	}
	return nil
}

// autoJudge：有 Live 时读任务当前授权里的开关（撤销 / 换代后一律关），否则用登记时的快照
func (r *BackgroundRun) autoJudge() bool {
	if r.Live == nil {
		return r.AutoJudge
	}
	if g, ok := r.Live(); ok {
		return g.AutoJudge
	}
	return false
}

// CurrentConnections：经连接的工具按任务当前授权收窄
func (r *BackgroundRun) CurrentConnections() []ConnGrant { return r.conns() }

// taskPaths：nil = 不收窄
func (r *BackgroundRun) taskPaths() []string {
	if r.Trusted {
		return nil
	}
	if r.Live == nil {
		return r.Paths
	}
	if g, ok := r.Live(); ok {
		if g.Paths == nil {
			return []string{}
		}
		return g.Paths
	}
	return []string{}
}

// ConnGrant：授权里引用连接的方式
type ConnGrant struct {
	ConnectionID string
	Capabilities []string
	Resources    []string
}

type bgKey struct{}

// WithBackground：把后台执行登记到 ctx 上（之后这条 ctx 及其派生上的审批都走后台规则）
func WithBackground(ctx context.Context, run *BackgroundRun) context.Context {
	return context.WithValue(ctx, bgKey{}, run)
}

func BackgroundFrom(ctx context.Context) *BackgroundRun {
	if ctx == nil {
		return nil
	}
	run, _ := ctx.Value(bgKey{}).(*BackgroundRun)
	return run
}

// BackgroundExternal：后台执行的副作用日志；前台对话返回 nil
func BackgroundExternal(ctx context.Context) connections.ExternalJournal {
	if run := BackgroundFrom(ctx); run != nil {
		return run.External
	}
	return nil
}

func (r *BackgroundRun) grants() []connections.Grant {
	cs := r.conns()
	out := make([]connections.Grant, 0, len(cs))
	for _, g := range cs {
		out = append(out, connections.Grant{ConnectionID: g.ConnectionID, Capabilities: g.Capabilities, Resources: g.Resources})
	}
	return out
}

// hasGithubExternal：授权里给了 GitHub 的对外能力（github.comment / github.pr.create）
func (r *BackgroundRun) hasGithubExternal() bool {
	for _, g := range r.conns() {
		for _, c := range g.Capabilities {
			if strings.HasPrefix(c, "github.") && connections.IsExternalCapability(c) {
				return true
			}
		}
	}
	return false
}

// 各类动作要求的最低授权等级：写本机 L2，跑命令 L3；对外动作（MCP 非只读工具、对外命令）L4
var backgroundLevel = map[Danger]int{"read": 1, "write": 2, "destructive": 2}

const (
	commandLevel  = 3
	externalLevel = 4
)

func (b *PermissionBroker) authorizeBackground(run *BackgroundRun, i AuthorizeInput) Decision {
	if i.Signal.Err() != nil {
		return "denied"
	}
	// MCP 工具（<服务器>__<工具>）：不继承服务器的前台信任级别，只认任务授权里逐个给出的工具
	// （docs/features/scheduling-calendar.md）；只读工具给了就跑，对外工具还要 L4，读过外部内容时问人
	if server, tool, ok := connections.SplitMcpTool(i.Tool); ok {
		granted := connections.McpGranted(run.grants(), server, tool, i.McpReadOnly)
		if granted == "" {
			return "denied"
		}
		if granted == "read" {
			return "auto"
		}
		if run.level() < externalLevel {
			return "denied"
		}
		if run.Trusted || (!b.IsTainted(i.Signal) && !run.Tainted) {
			return "auto"
		}
		detail := i.Summary
		if i.Preview != nil {
			detail = *i.Preview
		}
		if r := []rune(detail); len(r) > ConfirmPreviewCap {
			detail = string(r[:ConfirmPreviewCap])
		}
		if i.Signal.Err() != nil {
			return "denied"
		}
		ok := run.Ask(i.Tool, i.Summary, detail)
		if i.Signal.Err() != nil || !ok {
			return "denied"
		}
		// 等批准期间授权可能被收窄：按当前授权再核一次（#232）
		if run.level() < externalLevel || connections.McpGranted(run.grants(), server, tool, i.McpReadOnly) != granted {
			return "denied"
		}
		return "allowed"
	}
	if i.Danger == "read" && i.Force == nil {
		return "auto"
	}
	command := ReviewedTools[i.Tool]
	need := backgroundLevel[i.Danger]
	if command {
		need = commandLevel
	}
	if run.level() < need {
		return "denied"
	}
	detail := i.Summary
	if i.Preview != nil {
		detail = *i.Preview
	}
	// 确定性分类在审核之前（command_class.go）：读凭据、合并发布等永远问人；对外命令要 L4，
	// 且授权里给了 GitHub 的对外能力（github.comment / github.pr.create）
	cmdText, _, _ := parseCommandArgs(i.Args)
	// hard：确定性分类命中永远问人的类；highRisk：审核判为 high / critical（「全部自动」也不放行这两类）
	hard, highRisk := false, false
	cls := ""
	if command {
		cls = ClassifyCommand(cmdText)
	}
	if cls == "credential" || cls == "never" || (cls == "external" && (run.level() < externalLevel || !run.hasGithubExternal())) {
		detail = "[" + cls + "] " + detail
		hard = true
	} else if command && b.commandRuleFor(i) != "" && !run.Tainted && !b.IsTainted(i.Signal) {
		// 命令白名单：与前台一致，读过外部内容时不认
		return "auto"
	} else if command {
		if cmd, cwd, ok := b.reviewableBackground(i, run.autoJudge() && run.level() >= commandLevel); ok {
			review := b.review(i, cmd, cwd)
			// 与前台一致：审核放行就直接跑（workspace_run 总带 Force，审核结果优先）
			if review != nil && review.Outcome == "allow" && !run.Tainted {
				return "auto"
			}
			if review != nil {
				highRisk = review.Risk == "high" || review.Risk == "critical"
				d := string(review.Risk)
				if review.Rationale != "" {
					d += ": " + review.Rationale
				}
				detail = d + "\n" + detail
			}
		}
	} else if i.Danger == "write" && i.Force == nil && (run.Trusted || (!b.IsTainted(i.Signal) && !run.Tainted)) {
		if b.Policy(i.Tool, i.Danger) != "ask" {
			return "auto"
		}
	}
	if i.Signal.Err() != nil {
		return "denied"
	}
	if r := []rune(detail); len(r) > ConfirmPreviewCap {
		detail = string(r[:ConfirmPreviewCap])
	}
	// 前台「全部自动」对后台任务生效：只放行写入与（审核没判高风险的）命令；
	// 凭据 / 永不放行类、破坏性动作、事件触发读过外部内容后的操作仍问人
	if run.AutoAll != nil && run.AutoAll() && !hard && !highRisk && !run.Tainted && !b.IsTainted(i.Signal) &&
		(command || i.Danger == "write") {
		return "auto"
	}
	ok := run.Ask(i.Tool, i.Summary, detail)
	if i.Signal.Err() != nil {
		return "denied"
	}
	// 等批准期间授权可能被收窄：按当前授权再核一次（#232）
	if run.level() < need {
		return "denied"
	}
	if ok {
		return "allowed"
	}
	return "denied"
}

// WithinTaskPaths：后台执行的路径还要落在任务授权的文件夹里（与全局授权求交集，#231）；
// 前台对话或不收窄的（高级权限）总是 true。real 是 GuardPath 解析过的真实路径
func (b *PermissionBroker) WithinTaskPaths(ctx context.Context, real string) bool {
	run := BackgroundFrom(ctx)
	if run == nil {
		return true
	}
	roots := run.taskPaths()
	if roots == nil {
		return true
	}
	for _, r := range roots {
		root := r
		rp := b.envBase.Realpath
		if rp == nil {
			rp = RealpathNative
		}
		if v, err := rp(r); err == nil {
			root = v
		}
		if IsInside(real, root, b.envBase.Platform) {
			return true
		}
	}
	return false
}

// reviewableBackground：后台不看前台的「计划」档，其余条件同 reviewable；
// autoJudge（任务开了按风险自动判断）时不看「命令自动审核」开关，只要有审核器就审
func (b *PermissionBroker) reviewableBackground(i AuthorizeInput, autoJudge bool) (cmd, cwd string, ok bool) {
	if !ReviewedTools[i.Tool] || b.Reviewer == nil {
		return "", "", false
	}
	if !autoJudge && (b.AIReview == nil || !b.AIReview()) {
		return "", "", false
	}
	return parseCommandArgs(i.Args)
}
