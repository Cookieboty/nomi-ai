// Package usage ports the leaves of apps/desktop-electron/internal/core/src/usage used by core/cli（cliHomes / limitedProcess /
// grokAuth / sqliteRead / quality/cliTokens）。
package usage

import (
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func expand(o *util.Obj, k, home string) (string, bool) {
	raw, _ := Str(o, k)
	v := util.JSTrim(raw)
	if v == "" {
		return "", false
	}
	if v == "~" {
		return home, true
	}
	if strings.HasPrefix(v, "~/") || strings.HasPrefix(v, `~\`) {
		return filepath.Join(home, v[2:]), true
	}
	a, _ := filepath.Abs(v)
	return a, true
}

func or(v string, ok bool, def string) string {
	if ok {
		return v
	}
	return def
}

func ClaudeConfigDir(home string, env *util.Obj) string {
	v, ok := expand(env, "CLAUDE_CONFIG_DIR", home)
	return or(v, ok, filepath.Join(home, ".claude"))
}

func CodexHomeDir(home string, env *util.Obj) string {
	v, ok := expand(env, "CODEX_HOME", home)
	return or(v, ok, filepath.Join(home, ".codex"))
}

func GeminiDir(home string, env *util.Obj) string {
	v, ok := expand(env, "GEMINI_CLI_HOME", home)
	return filepath.Join(or(v, ok, home), ".gemini")
}

func QwenDir(home string, env *util.Obj) string {
	v, ok := expand(env, "QWEN_HOME", home)
	return or(v, ok, filepath.Join(home, ".qwen"))
}

func OpencodeDir(home string, env *util.Obj) string {
	if v, ok := expand(env, "OPENCODE_HOME", home); ok {
		return v
	}
	x, ok := expand(env, "XDG_DATA_HOME", home)
	return filepath.Join(or(x, ok, filepath.Join(home, ".local", "share")), "opencode")
}

func CopilotDir(home string, env *util.Obj) string {
	v, ok := expand(env, "COPILOT_HOME", home)
	return or(v, ok, filepath.Join(home, ".copilot"))
}

func KimiDirs(home string, env *util.Obj) []string {
	a, ok := expand(env, "KIMI_HOME", home)
	b, ok2 := expand(env, "KIMI_CODE_HOME", home)
	return []string{or(a, ok, filepath.Join(home, ".kimi")), or(b, ok2, filepath.Join(home, ".kimi-code"))}
}

func GrokHomeDir(home string, env *util.Obj) string {
	v, ok := expand(env, "GROK_HOME", home)
	return or(v, ok, filepath.Join(home, ".grok"))
}

// QualityLedgerInput mirrors quality/cliTokens.ts（nil = undefined）。
func QualityLedgerInput(client string, inputTokens, cacheReadTokens *float64) *float64 {
	if inputTokens == nil {
		return nil
	}
	if client == "codex" && cacheReadTokens != nil {
		v := *inputTokens - *cacheReadTokens
		if v < 0 || v != v {
			if v != v {
				return &v
			}
			v = 0
		}
		return &v
	}
	return inputTokens
}
