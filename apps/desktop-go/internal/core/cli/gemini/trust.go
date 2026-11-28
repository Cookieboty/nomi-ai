package gemini

import (
	geminip "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// GeminiUntrustedExitCode = GEMINI_UNTRUSTED_EXIT_CODE。
const GeminiUntrustedExitCode = geminip.UntrustedExitCode

// IsGeminiUntrustedExit = isGeminiUntrustedExit（exitCode nil = null）。
func IsGeminiUntrustedExit(exitCode *int, stderr string) bool {
	return geminip.IsUntrustedExit(exitCode, stderr)
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
func NewUntrustedError(folder string, cause error) error {
	return &UntrustedError{Folder: folder, Cause: cause}
}

// IsUntrustedModeError：Gemini 拒绝在没信任的文件夹里切到「自动编辑 / 完全放开」
func IsUntrustedModeError(msg string) bool { return geminip.IsUntrustedModeError(msg) }
