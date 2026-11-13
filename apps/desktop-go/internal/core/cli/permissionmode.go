package cli

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// permOf：backend 的权限能力（取内置插件的）
func permOf(backend string) *clisdk.PermissionCapability {
	if m := builtin.Impl(backend); m != nil && m.Permissions != nil {
		return m.Permissions
	}
	return nil
}

// PermissionModes = PERMISSION_MODES。
var PermissionModes = sh.PermissionModes

const DefaultPermissionMode = "acceptEdits"

func IsPermissionMode(v any) bool { return sh.IsPermissionMode(v) }

var nomiModes = func() []string {
	out := []string{}
	for _, m := range PermissionModes {
		if m != "bypass" {
			out = append(out, m)
		}
	}
	return out
}()

// SupportedModes = supportedModes。
func SupportedModes(backend string) []string {
	if backend == "nomi" {
		return nomiModes
	}
	return permOf(backend).Supported
}

// EffectiveMode = effectiveMode。
func EffectiveMode(backend, mode string) (string, bool) {
	supported := SupportedModes(backend)
	m, degraded := sh.DegradeMode(supported, mode)
	if !contains(supported, m) && len(supported) > 0 {
		return supported[0], true
	}
	return m, degraded
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

type PermissionLaunch struct {
	Args []string
	Env  *util.Obj
}

func ClaudeModeName(mode string) string { return permOf("claude").ModeID(mode) }

// PermissionLaunchFor = permissionLaunch（codexNetwork nil = undefined）。
func PermissionLaunchFor(backend, mode string, codexNetwork *bool) PermissionLaunch {
	a, e := permOf(backend).Launch(mode, codexNetwork)
	return PermissionLaunch{Args: a, Env: e}
}

func GeminiModeID(mode string) string { return permOf("gemini").ModeID(mode) }
func GrokModeID(mode string) string   { return permOf("grok").ModeID(mode) }
func AcpModeID(backend, mode string) string {
	return permOf(backend).ModeID(mode)
}

// FromCliPermissionMode = fromCliPermissionMode（"" = null）。
func FromCliPermissionMode(backend string, raw any) string {
	s, ok := raw.(string)
	if !ok || permOf(backend).FromModeID == nil {
		return ""
	}
	return permOf(backend).FromModeID(s)
}

// PlanPromptPrefix = planPromptPrefix（"" , false = null）。
func PlanPromptPrefix(backend string) (string, bool) {
	p := permOf(backend).PlanPrefix
	return p, p != ""
}
