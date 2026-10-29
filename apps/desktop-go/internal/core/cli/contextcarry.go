package cli

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	CarryMaxMessages = 40
	CarryMaxChars    = 4000
	CarryMaxTotal    = 60_000
)

type CarriedContext struct {
	Text     string `json:"text"`
	Messages int    `json:"messages"`
}

// BuildCarriedContext = buildCarriedContext（消息为 HarnessTabMessage 形状的 *util.Obj）；nil = null。
func BuildCarriedContext(messages []*util.Obj, fromCwd string) *CarriedContext {
	if n := len(messages); n > CarryMaxMessages*2 {
		messages = messages[n-CarryMaxMessages*2:]
	}
	lines := []string{}
	for _, m := range messages {
		if util.Truthy(m.Get("error")) {
			continue
		}
		c, _ := m.Get("content").(string) // content ?? ''（HarnessTabMessage.content 为 string）
		text := util.JSTrim(c)
		if text == "" {
			continue
		}
		body := text
		if clisdk.Len(text) > CarryMaxChars {
			body = clisdk.Slice0(text, CarryMaxChars) + "…"
		}
		who := "Assistant"
		if m.Get("role") == "user" {
			who = "User"
		}
		lines = append(lines, who+": "+body)
	}
	kept := lines
	if len(kept) > CarryMaxMessages {
		kept = kept[len(kept)-CarryMaxMessages:]
	}
	total := func() int {
		n := 0
		for _, l := range kept {
			n += clisdk.Len(l) + 1
		}
		return n
	}
	for len(kept) > 1 && total() > CarryMaxTotal {
		kept = kept[1:]
	}
	if len(kept) == 0 {
		return nil
	}
	parts := append([]string{i18n.T("electron.common.nomi-below-is-this-conversation-so-far-from", fromCwd), "<previous_conversation>"}, kept...)
	parts = append(parts, "</previous_conversation>")
	return &CarriedContext{Text: strings.Join(parts, "\n"), Messages: len(kept)}
}

// CarriedBudget = carriedBudget（platform 为 Node 的 process.platform 值）。
func CarriedBudget(backend, platform string) int {
	if backend == "claude" || backend == "gemini" {
		return CarryMaxTotal
	}
	if platform == "win32" {
		return 5000
	}
	return 30_000
}

var carrySplit = regexp.MustCompile(`\n(?:User|Assistant): `)

// splitBeforeMsg = body.split(/\n(?=(?:User|Assistant): )/)（RE2 无先行断言：手动切在 \n 处、保留后半）
func splitBeforeMsg(body string) []string {
	out := []string{}
	last := 0
	for _, loc := range carrySplit.FindAllStringIndex(body, -1) {
		out = append(out, body[last:loc[0]])
		last = loc[0] + 1
	}
	return append(out, body[last:])
}

// FitCarried = fitCarried；"" , false = null。
func FitCarried(text string, max int) (string, bool) {
	if clisdk.Len(text) <= max {
		return text, true
	}
	const openTag = "<previous_conversation>\n"
	open := strings.Index(text, openTag)
	close := strings.LastIndex(text, "\n</previous_conversation>")
	if open < 0 || close < 0 {
		return "", false
	}
	head := text[:open+len(openTag)]
	if close < len(head) { // JS slice(head.length, close) 起点大于终点 = ''；tail 仍 = text.slice(close)
		parts := []string{""}
		return fitLoop(head, parts, text[close:], max)
	}
	return fitLoop(head, splitBeforeMsg(text[len(head):close]), text[close:], max)
}

func fitLoop(head string, parts []string, tail string, max int) (string, bool) {
	hl, tl := clisdk.Len(head), clisdk.Len(tail)
	for len(parts) > 0 && hl+clisdk.Len(strings.Join(parts, "\n"))+tl > max {
		parts = parts[1:]
	}
	if len(parts) == 0 {
		return "", false
	}
	return head + strings.Join(parts, "\n") + tail, true
}

// WithCarriedContext = withCarriedContext（carried nil / "" = 无前文）。
func WithCarriedContext(carried *string, prompt string) string {
	if carried != nil && *carried != "" {
		return *carried + "\n\n---\n\n" + prompt
	}
	return prompt
}

// StripCarriedContext 由 cli-sdk 提供。
func StripCarriedContext(text string) string { return clisdk.StripCarriedContext(text) }
