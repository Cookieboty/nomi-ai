package shared

import (
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func expandHome(v string, home string) (string, bool) {
	s := util.JSTrim(v)
	if s == "" {
		return "", false
	}
	if s == "~" {
		return home, true
	}
	if strings.HasPrefix(s, "~/") || strings.HasPrefix(s, `~\`) {
		return filepath.Join(home, s[2:]), true
	}
	return Resolve(s), true
}

// Resolve = path.resolve(p)（相对 process.cwd()）。
func Resolve(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return a
}

// CliHome mirrors cliHome。
func CliHome(envVar, fallback string, env map[string]string, home string) string {
	if p, ok := expandHome(env[envVar], home); ok {
		return p
	}
	return filepath.Join(home, fallback)
}

// GeminiRoot mirrors geminiRoot。
func GeminiRoot(env map[string]string, home string) string {
	if p, ok := expandHome(env["GEMINI_CLI_HOME"], home); ok {
		return p
	}
	return home
}
