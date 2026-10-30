package claude

import (
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
)

// ParseTranscript mirrors parseClaudeTranscript。
func ParseTranscript(text string, fallbackAt float64) []sh.Json {
	b := sh.NewBuilder()
	for _, e := range sh.Lines(text) {
		if e.Get("isSidechain") == true {
			continue
		}
		msg := sh.AsJ(e.Get("message"))
		at := sh.When(e.Get("timestamp"), fallbackAt)
		switch e.Get("type") {
		case "user":
			if e.Get("isMeta") == true {
				continue
			}
			t, _ := sh.Blocks(msg.Get("content"))
			sh.FeedBlocks(b, msg.Get("content"), at, "")
			if t != "" {
				b.User(t, at)
			}
		case "assistant":
			if e.Get("isApiErrorMessage") == true {
				continue
			}
			sh.WalkAssistant(b, msg.Get("content"), at, sh.UsageOf(sh.AsJ(msg.Get("usage"))))
		}
	}
	return b.Result()
}
