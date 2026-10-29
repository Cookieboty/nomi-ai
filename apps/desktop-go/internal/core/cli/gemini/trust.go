package gemini

import (
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// GeminiUntrustedExitCode = GEMINI_UNTRUSTED_EXIT_CODE。
const GeminiUntrustedExitCode = 55

var untrustedRe = regexp.MustCompile(`(?i)not running in a trusted directory|--skip-trust|GEMINI_CLI_TRUST_WORKSPACE`)

// IsGeminiUntrustedExit = isGeminiUntrustedExit（exitCode nil = null）。
func IsGeminiUntrustedExit(exitCode *int, stderr string) bool {
	return (exitCode != nil && *exitCode == GeminiUntrustedExitCode) || untrustedRe.MatchString(stderr)
}

// GeminiUntrustedMessage = geminiUntrustedMessage。
func GeminiUntrustedMessage(cwd string) string {
	return i18n.T("electron.common.gemini-cli-does-not-trust-the-current-folder", cwd)
}

// UntrustedError = GeminiUntrustedError。
type UntrustedError struct {
	Folder string
	Cause  error
}

func (e *UntrustedError) Error() string { return GeminiUntrustedMessage(e.Folder) }
func (e *UntrustedError) Name() string  { return "GeminiUntrustedError" }
func (e *UntrustedError) Unwrap() error { return e.Cause }

// NewUntrustedError 构造 GeminiUntrustedError。
func NewUntrustedError(folder string, cause error) error { return &UntrustedError{Folder: folder, Cause: cause} }

// GeminiLoginEnv = geminiLoginEnv（键序同 Node 字面量）。
func GeminiLoginEnv(stagingDir string) [][2]string {
	return [][2]string{{"GEMINI_CLI_HOME", stagingDir}, {"GEMINI_CLI_TRUST_WORKSPACE", "true"}}
}
