package shared

import (
	"regexp"
	"strings"

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

// DegradeMode mirrors degradeMode。
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

var ClaudeMode = map[string]string{"plan": "plan", "manual": "default", "acceptEdits": "acceptEdits", "auto": "auto", "bypass": "bypassPermissions"}

var sepRun = regexp.MustCompile(`[_` + util.JSWhitespace[1:len(util.JSWhitespace)-1] + `]+`)

// ModeFromNative mirrors modeFromNative（"" = null；onRequest "" = 未给）。
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

const PlanPromptPrefix = "You are in plan mode: do not modify any files. Investigate as needed, then reply with a complete implementation plan in Markdown and wait for approval.\n\n"

var _ = strings.ToLower
