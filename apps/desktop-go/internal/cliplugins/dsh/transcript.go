package dsh

import (
	"regexp"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var toolEndRe = regexp.MustCompile(`(?i)^tool[/_-]?(result|end|output)`)

// ParseTranscript mirrors parseDshTranscript。
func ParseTranscript(text string, fallbackAt float64) []sh.Json {
	b := sh.NewBuilder()
	for _, e := range sh.Lines(text) {
		data := sh.AsJ(e.Get("data"))
		at := sh.When(e.Get("time"), fallbackAt)
		typ, isStr := e.Get("type").(string)
		switch {
		case typ == "user/message":
			if sh.AsJ(data.Get("source")).Get("kind") != "user" {
				continue
			}
			t, _ := sh.Blocks(data.Get("content"))
			b.User(t, at)
		case typ == "assistant/message":
			sh.WalkAssistant(b, sh.AsJ(data.Get("message")).Get("content"), at, sh.UsageOf(sh.AsJ(data.Get("usage"))))
		case isStr && toolEndRe.MatchString(util.JSIText(typ)):
			if id, ok := sh.NStrOr(data.Get("toolCallId"), data.Get("callId"), data.Get("id")); ok {
				b.ToolEnd(sh.ToolEnd{ID: id, Output: sh.Nullish(data.Get("output"), data.Get("result"), data.Get("content")),
					Error: data.Get("isError") == true || data.Has("error"), At: at})
			}
		}
	}
	return b.Result()
}
