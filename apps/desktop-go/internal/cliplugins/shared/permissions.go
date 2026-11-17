package shared

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var PermissionModes = []string{"plan", "manual", "acceptEdits", "auto", "bypass"}

func IsPermissionMode(v any) bool {
	s, ok := v.(string)
	return ok && contains(PermissionModes, s)
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// DegradeMode：mode 不受支持时降级到最接近的受支持模式。
func DegradeMode(supported []string, mode string) (string, bool) {
	if contains(supported, mode) {
		return mode, false
	}
	next := map[string]string{"manual": "plan", "auto": "acceptEdits"}[mode]
	if next != "" && contains(supported, next) {
		return next, true
	}
	return "plan", true
}

// ClaudeMode：Nomi 档位 → Claude --permission-mode 名（与 packages/cli-catalog 的 CLAUDE_MODE 一致）。
// auto = 由 Claude 自己判断哪些动作要确认（Nomi「自动」档的语义）；
// 但判断跑在服务端，第三方网关下不可达 —— orchestrator 会按端点降级到 acceptEdits。
var ClaudeMode = map[string]string{"plan": "plan", "manual": "default", "acceptEdits": "acceptEdits", "auto": "auto", "bypass": "bypassPermissions"}

var sepRun = regexp.MustCompile(`[_` + util.JSWhitespace[1:len(util.JSWhitespace)-1] + `]+`)

// ModeFromNative：CLI 原生权限值 → 模式（"" = null；onRequest "" = 未给）。
func ModeFromNative(supported []string, raw any, onRequest string) string {
	s, ok := raw.(string)
	if !ok || util.JSTrim(s) == "" {
		return ""
	}
	value := util.JSTrim(s)
	if IsPermissionMode(value) {
		m, _ := DegradeMode(supported, value)
		return m
	}
	lower := sepRun.ReplaceAllString(util.JSLower(value), "-")
	mode := ""
	switch lower {
	case "plan", "read-only", "readonly":
		mode = "plan"
	case "default", "manual", "ask":
		mode = "manual"
	case "on-request":
		mode = onRequest
		if mode == "" {
			mode = "manual"
		}
	case "acceptedits", "autoedit", "workspace-write", "workspacewrite", "workspace":
		mode = "acceptEdits"
	case "auto", "dontask", "on-request-auto":
		mode = "auto"
	case "bypass", "bypasspermissions", "yolo", "danger-full-access", "dangerfullaccess", "danger":
		mode = "bypass"
	}
	if mode == "" {
		return ""
	}
	m, _ := DegradeMode(supported, mode)
	return m
}

// PlanPromptPrefix：计划模式附在用户消息前的说明（prompts/text/plan-mode.md）
var PlanPromptPrefix = prompts.Text("plan-mode") + "\n\n"

var _ = strings.ToLower
