package cli

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HistoryMaxMessages = sh.HistoryMaxMessages

// ParseTranscript = historyTranscript.parseTranscript。
func ParseTranscript(backend, text string, fallbackAt float64) []*util.Obj {
	e, _ := builtin.Get(backend)
	return e.Transcript(text, fallbackAt)
}

func TitleFromMessages(msgs []*util.Obj) *string { return sh.TitleFromMessages(msgs) }

// InstallPluginTranslate = pluginI18n（import 副作用）：宿主启动时调用一次。
func InstallPluginTranslate() {
	clisdk.SetTranslate(func(key string, args ...any) string { return i18n.T(key, args...) })
}
