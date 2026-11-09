package desktop

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codingcli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
)

// 对话请求发出前的准备：prepareChat + applyConversationWorkspace + receiversFor/checkSendAll

// ReceiversFor = receiversFor(provider, roles)：有 provider 用它；否则取候选角色里的全部 provider（按 id 去重）
func ReceiversFor(provider *Provider, roles []Role, providerFor func(Role) *Provider) []*Provider {
	if provider != nil {
		return []*Provider{provider}
	}
	out := []*Provider{}
	for _, r := range roles {
		p := providerFor(r)
		if p == nil {
			continue
		}
		dup := false
		for _, x := range out {
			if x.ID == p.ID {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, p)
		}
	}
	return out
}

// CheckSendAll = checkSendAll：逐个校验，返回第一个失败码，全通过 ""
func CheckSendAll(receivers []*Provider, signal context.Context, what string, checkSend func(*Provider, context.Context, string) string) string {
	for _, r := range receivers {
		if res := checkSend(r, signal, what); res != "" {
			return res
		}
	}
	return ""
}

// ReceiversFor 方法形式（provider 为 nil = undefined）
func (s *Service) ReceiversFor(provider *Provider, roles []Role) []*Provider {
	return ReceiversFor(provider, roles, s.ProviderFor)
}

// CheckSendAll 方法形式
func (s *Service) CheckSendAll(receivers []*Provider, signal context.Context, what string) string {
	return CheckSendAll(receivers, signal, what, s.Broker.CheckSend)
}

// WorkspaceSystemHint：项目提示（prompts/text/workspace.md）
func WorkspaceSystemHint(name string, ws Workspace, autoApprove bool) string {
	return prompts.Render("workspace", map[string]any{"Name": name, "Workspace": ws.Primary, "Extra": ws.Extra, "AutoApprove": autoApprove, "HasCli": codingcli.Available()})
}

// WorkspaceBroker：PrepareChat 用到的 PermissionBroker 能力
type WorkspaceBroker struct {
	WorkspaceOf func(projectID any) Workspace
	ProjectName func(id string) string
	AutoApprove func() bool
}

// ApplyConversationWorkspace：按 extra.projectId 取这一轮的项目目录（就地改写 options）。
// 视图只能带 projectId；extra.cwd 由这里按项目的主文件夹重写（视图带来的一律丢掉），工具的工作目录与门控用它。
func ApplyConversationWorkspace(options map[string]any, b WorkspaceBroker) (Workspace, error) {
	rawExtra := options["extra"]
	if !jsTruthy(rawExtra) {
		return Workspace{}, nil
	}
	extra, isObj := rawExtra.(map[string]any)
	if !isObj {
		if _, isArr := rawExtra.([]any); isArr {
			return Workspace{}, nil
		}
		return Workspace{}, errors.New("Cannot use 'in' operator to search for 'projectId' in " + jsString(rawExtra))
	}
	delete(extra, "cwd")
	pid, has := extra["projectId"]
	if !has {
		return Workspace{}, nil
	}
	ws := b.WorkspaceOf(pid)
	if ws.Empty() {
		delete(extra, "projectId")
		return Workspace{}, nil
	}
	extra["projectId"] = ws.ProjectID
	extra["cwd"] = ws.Primary
	name := ""
	if b.ProjectName != nil {
		name = b.ProjectName(ws.ProjectID)
	}
	hint := WorkspaceSystemHint(name, ws, b.AutoApprove())
	if msgs, ok := options["messages"].([]any); ok {
		for _, x := range msgs {
			if x == nil {
				return Workspace{}, errors.New("Cannot read properties of null (reading 'role')")
			}
			m, _ := x.(map[string]any)
			if m == nil {
				continue
			}
			if m["role"] == "system" {
				if c, ok := m["content"].(string); ok {
					m["content"] = c + "\n\n" + hint
					return ws, nil
				}
			}
		}
		options["messages"] = append([]any{map[string]any{"role": "system", "content": hint}}, msgs...)
	}
	return ws, nil
}

func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && x == x
	}
	return true
}

func jsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}

// ChatPrep prepareChat 的依赖（services.desktop 的切片）
type ChatPrep struct {
	Broker      WorkspaceBroker
	ProviderFor func(Role) *Provider
	CheckSend   func(*Provider, context.Context, string) string
	// AfterWorkspace：会话工作区之后、外发检查之前的就地改写（main.go 在这里追加派出去的判断规则）
	AfterWorkspace func(options map[string]any, method string) error
}

// ChatPrep 取本服务的依赖
func (s *Service) ChatPrep() ChatPrep {
	return ChatPrep{
		Broker: WorkspaceBroker{WorkspaceOf: s.Broker.WorkspaceOf,
			ProjectName: func(id string) string { return s.Broker.ProjectName(id) },
			AutoApprove: func() bool { return s.Broker.AutoApprove() }},
		ProviderFor: s.ProviderFor,
		CheckSend:   s.Broker.CheckSend,
	}
}

// PrepareChat：AI 路由的 prepareChat 钩子
func (c ChatPrep) PrepareChat(options map[string]any, method string, signal <-chan struct{}) error {
	if _, err := ApplyConversationWorkspace(options, c.Broker); err != nil {
		return err
	}
	if c.AfterWorkspace != nil {
		if err := c.AfterWorkspace(options, method); err != nil {
			return err
		}
	}
	ctx, cancel := chanContext(signal)
	defer cancel()
	return GuardOutboundMessages(options["messages"], func(what string) SendVerdict {
		fallback := "chat"
		if strings.HasPrefix(method, "agent") {
			fallback = "agent-tools"
		}
		role := fallback
		if r, ok := options["role"].(string); ok && (r == "chat" || r == "agent-tools" || r == "summary") {
			role = r
		}
		return CheckSendAll(ReceiversFor(nil, []Role{role}, c.ProviderFor), ctx, what, c.CheckSend)
	})
}

func chanContext(signal <-chan struct{}) (context.Context, context.CancelFunc) {
	if signal == nil {
		return context.Background(), func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		select {
		case <-signal:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}
