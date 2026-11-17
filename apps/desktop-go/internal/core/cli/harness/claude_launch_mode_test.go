package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func ptr(s string) *string { return &s }

// 「自动」在 Claude 上是「Claude 自己判断」，靠服务端分类器（beta auto-mode-classifier-*）。
// 请求走第三方端点、但端点提供的确实是 Claude 模型时，分类器照样能跑（用户实测可用），
// 必须原样下发 auto —— 不要再按「是不是官方端点」一刀切降级。
func TestClaudeAutoStaysForClaudeModel(t *testing.T) {
	o := &Orchestrator{}
	for _, model := range []string{"", "claude-fable-5", "amux/claude-fable-5", "amux/anthropic/claude-fable-5"} {
		tab := util.NewObj("backend", "claude", "permissionMode", "auto")
		if got := o.claudeLaunchMode(tab, false, ptr(model)); got != "auto" {
			t.Errorf("模型 %q 走第三方端点，auto 应原样下发，实际 %q", model, got)
		}
		if tab.Get("permissionModeCli") != nil {
			t.Errorf("模型 %q 不该记 permissionModeCli", model)
		}
	}
}

// 主模型不是 Claude 时（如 amux/deepseek-v4.1-flash、amux/gpt-6.1-terra），分类器请求会被
// 路由到那个非 Claude 模型，拿不到 verdict；而 Nomi 用 `-p` 长驻进程、attended=false，
// Claude 连「退而询问用户」都做不到 —— 每个要检查的动作都会被硬拒。
// 这时降为 acceptEdits（Claude 自己按规则判断，其余动作走 Nomi 的审批卡），不是 bypass。
func TestClaudeAutoFallsBackForNonClaudeModel(t *testing.T) {
	o := &Orchestrator{}
	for _, model := range []string{"amux/deepseek-v4.1-flash", "amux/gpt-6.1-terra", "qwen3.7-max", "kimi-k2"} {
		tab := util.NewObj("backend", "claude", "permissionMode", "auto")
		if got := o.claudeLaunchMode(tab, false, ptr(model)); got != "acceptEdits" {
			t.Errorf("模型 %q 不是 Claude，auto 应降到 acceptEdits，实际 %q", model, got)
		}
		if got := util.Str(tab.Get("permissionModeCli")); got != "acceptEdits" {
			t.Errorf("模型 %q 应记 permissionModeCli=acceptEdits，实际 %q", model, got)
		}
	}
}

// 官方登录 + 非 Claude 模型（官方端点只会是 Claude，这里只为把规则钉住）：
// 官方端点不需要降级，保持 auto。
func TestClaudeAutoOnOfficialLaunch(t *testing.T) {
	o := &Orchestrator{}
	tab := util.NewObj("backend", "claude", "permissionMode", "auto")
	if got := o.claudeLaunchMode(tab, true, ptr("amux/deepseek-v4.1-flash")); got != "auto" {
		t.Errorf("官方来源应保持 auto，实际 %q", got)
	}
}

// 其它档位不受这条规则影响。
func TestClaudeOtherModesUntouched(t *testing.T) {
	o := &Orchestrator{}
	for _, mode := range []string{"plan", "manual", "acceptEdits", "bypass"} {
		tab := util.NewObj("backend", "claude", "permissionMode", mode)
		if got := o.claudeLaunchMode(tab, false, ptr("amux/gpt-6.1-terra")); got != mode {
			t.Errorf("%s 不该被改，实际 %q", mode, got)
		}
	}
}

func TestIsClaudeModel(t *testing.T) {
	for _, m := range []string{"", "claude-fable-5", "amux/claude-fable-5", "Claude-Opus-5", "amux/claude-sonnet-5"} {
		if !isClaudeModel(m) {
			t.Errorf("%q 应识别为 Claude", m)
		}
	}
	for _, m := range []string{"amux/gpt-6.1-terra", "deepseek-v4.1-flash", "qwen3.7-max", "kimi-k2", "grok-5"} {
		if isClaudeModel(m) {
			t.Errorf("%q 不该识别为 Claude", m)
		}
	}
}
