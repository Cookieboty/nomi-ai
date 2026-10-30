package cli

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HistoryMaxMessages = sh.HistoryMaxMessages

var transcriptParsers = map[string]func(string, float64) []sh.Json{
	"claude": claude.ParseTranscript,
	"codex":  codex.ParseTranscript,
	"dsh":    dsh.ParseTranscript,
	"gemini": gemini.ParseTranscript,
	"grok":   grok.ParseTranscript,
}

// ParseTranscript = historyTranscript.parseTranscript。
func ParseTranscript(backend, text string, fallbackAt float64) []*util.Obj {
	return transcriptParsers[backend](text, fallbackAt)
}

func TitleFromMessages(msgs []*util.Obj) *string { return sh.TitleFromMessages(msgs) }

// InstallPluginTranslate = pluginI18n（import 副作用）：宿主启动时调用一次。
func InstallPluginTranslate() {
	clisdk.SetTranslate(func(key string, args ...any) string { return i18n.T(key, args...) })
}
