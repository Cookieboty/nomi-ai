package desktop

// 后台任务的审批（docs/design/persistent-tasks.md §8.4），对应 PermissionBroker.ts 的 registerBackground /
// authorizeBackground。Go 用 context 携带：派生的 context（工具执行时拿到的）自然继承。

import (
	"context"
	"strings"
)

// BackgroundRun：一次后台任务执行；Ask 让任务停到「等你批准」并阻塞到用户回答
type BackgroundRun struct {
	Level int
	Ask   func(tool, summary, detail string) bool
	// Connections：任务授权里的连接（connections.md §2）；经连接的工具据此收窄
	Connections []ConnGrant
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

// 各类动作要求的最低授权等级：写本机 L2，跑命令 L3，MCP 工具（<服务器>__<工具>）L4
var backgroundLevel = map[Danger]int{"read": 1, "write": 2, "destructive": 2}

const (
	commandLevel  = 3
	externalLevel = 4
)

func (b *PermissionBroker) authorizeBackground(run *BackgroundRun, i AuthorizeInput) Decision {
	if i.Signal.Err() != nil {
		return "denied"
	}
	if i.Danger == "read" && i.Force == nil {
		return "auto"
	}
	command := ReviewedTools[i.Tool]
	need := backgroundLevel[i.Danger]
	switch {
	case command:
		need = commandLevel
	case strings.Contains(i.Tool, "__"):
		need = externalLevel
	}
	if run.Level < need {
		return "denied"
	}
	detail := i.Summary
	if i.Preview != nil {
		detail = *i.Preview
	}
	if command {
		if cmd, cwd, ok := b.reviewableBackground(i); ok {
			review := b.review(i, cmd, cwd)
			// 与前台一致：审核放行就直接跑（workspace_run 总带 Force，审核结果优先）
			if review != nil && review.Outcome == "allow" {
				return "auto"
			}
			if review != nil {
				d := string(review.Risk)
				if review.Rationale != "" {
					d += ": " + review.Rationale
				}
				detail = d + "\n" + detail
			}
		}
	} else if i.Danger == "write" && i.Force == nil && !b.IsTainted(i.Signal) {
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
	ok := run.Ask(i.Tool, i.Summary, detail)
	if i.Signal.Err() != nil {
		return "denied"
	}
	if ok {
		return "allowed"
	}
	return "denied"
}

// reviewableBackground：后台不看前台的「计划」档，其余条件同 reviewable
func (b *PermissionBroker) reviewableBackground(i AuthorizeInput) (cmd, cwd string, ok bool) {
	if !ReviewedTools[i.Tool] || b.Reviewer == nil || b.AIReview == nil || !b.AIReview() {
		return "", "", false
	}
	return parseCommandArgs(i.Args)
}
