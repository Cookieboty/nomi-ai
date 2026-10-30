package cli

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// externalPermissions = EXTERNAL_PERMISSIONS（外部插件只有「逐项确认」）。
var externalPermissions = &clisdk.PermissionCapability{
	Supported:  []string{"manual"},
	Launch:     func(string, *bool) ([]string, *util.Obj) { return []string{}, util.NewObj() },
	ModeID:     func(string) string { return "" },
	FromModeID: func(string) string { return "" },
}

var perms = map[string]*clisdk.PermissionCapability{
	"claude": claude.Permissions, "codex": codex.Permissions, "dsh": dsh.Permissions,
	"grok": grok.Permissions, "gemini": gemini.Permissions, "external": externalPermissions,
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
	return perms[backend].Supported
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

func ClaudeModeName(mode string) string { return perms["claude"].ModeID(mode) }

// PermissionLaunchFor = permissionLaunch（codexNetwork nil = undefined）。
func PermissionLaunchFor(backend, mode string, codexNetwork *bool) PermissionLaunch {
	a, e := perms[backend].Launch(mode, codexNetwork)
	return PermissionLaunch{Args: a, Env: e}
}

func GeminiModeID(mode string) string { return perms["gemini"].ModeID(mode) }
func GrokModeID(mode string) string   { return perms["grok"].ModeID(mode) }
func AcpModeID(backend, mode string) string {
	return perms[backend].ModeID(mode)
}

// FromCliPermissionMode = fromCliPermissionMode（"" = null）。
func FromCliPermissionMode(backend string, raw any) string {
	s, ok := raw.(string)
	if !ok || perms[backend].FromModeID == nil {
		return ""
	}
	return perms[backend].FromModeID(s)
}

// PlanPromptPrefix = planPromptPrefix（"" , false = null）。
func PlanPromptPrefix(backend string) (string, bool) {
	p := perms[backend].PlanPrefix
	return p, p != ""
}
