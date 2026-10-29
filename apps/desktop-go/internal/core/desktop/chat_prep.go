package desktop

import (
	"context"
	"errors"
	"strconv"
	"strings"
)

// createCore.ts prepareChat + workspaceTools.ts applyConversationWorkspace + DesktopService.receiversFor/checkSendAll

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

// WorkspaceSystemHint = workspaceSystemHint
func WorkspaceSystemHint(ws string, autoApprove bool) string {
	s := "这次对话的工作区是 " + ws + "。文件工具（fs_*）默认在工作区里用，相对路径相对于工作区；" +
		"工作区外只能访问用户单独授权过的文件夹（需要时用 desktop_request_scope 请用户授权，照常确认），其它位置会被拒绝。" +
		"workspace_run 只在工作区里执行。"
	if autoApprove {
		s += "工作区里的文件和命令操作不需要用户逐项确认。"
	}
	return s + "委派编程助手（delegate_to_cli）时它也在工作区里开工。"
}

// WorkspaceBroker = Pick<PermissionBroker, 'workspaceOf' | 'autoApprove'>
type WorkspaceBroker struct {
	WorkspaceOf func(cwd any) string // "" = null
	AutoApprove func() bool
}

// ApplyConversationWorkspace = applyConversationWorkspace（就地改写 options；返回 "" = null）
func ApplyConversationWorkspace(options map[string]any, b WorkspaceBroker) (string, error) {
	rawExtra := options["extra"]
	if !jsTruthy(rawExtra) {
		return "", nil
	}
	extra, isObj := rawExtra.(map[string]any)
	if !isObj {
		if _, isArr := rawExtra.([]any); isArr {
			return "", nil
		}
		// 'cwd' in <primitive> 抛 TypeError
		return "", errors.New("Cannot use 'in' operator to search for 'cwd' in " + jsString(rawExtra))
	}
	cwd, has := extra["cwd"]
	if !has {
		return "", nil
	}
	ws := b.WorkspaceOf(cwd)
	if ws == "" {
		delete(extra, "cwd")
		return "", nil
	}
	extra["cwd"] = ws
	hint := WorkspaceSystemHint(ws, b.AutoApprove())
	if msgs, ok := options["messages"].([]any); ok {
		for _, x := range msgs {
			if x == nil {
				return "", errors.New("Cannot read properties of null (reading 'role')")
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
}

// ChatPrep 取本服务的依赖
func (s *Service) ChatPrep() ChatPrep {
	return ChatPrep{
		Broker:      WorkspaceBroker{WorkspaceOf: s.Broker.WorkspaceOf, AutoApprove: func() bool { return s.Broker.AutoApprove() }},
		ProviderFor: s.ProviderFor,
		CheckSend:   s.Broker.CheckSend,
	}
}

// PrepareChat = createCore.ts AiRouterOptions.prepareChat
func (c ChatPrep) PrepareChat(options map[string]any, method string, signal <-chan struct{}) error {
	if _, err := ApplyConversationWorkspace(options, c.Broker); err != nil {
		return err
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
