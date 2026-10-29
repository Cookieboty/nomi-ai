package desktop

import (
	"errors"
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/tr"
)

// outboundGuard.ts：外发给云端模型前，把附件正文 / 编码助手输出按设置挡下或替换

type SendVerdict = string // "" | local_only | user_denied

type OutboundCheck func(what string) SendVerdict

var (
	reFileBody  = regexp.MustCompile(`<attached-file (name="[^"]*"(?: path="[^"]*")?)>\n[\s\S]*?\n</attached-file>`)
	reCliOutput = regexp.MustCompile(`<cli-output>[\s\S]*?</cli-output>`)
)

const withheld = `(Content withheld: shown only on this device. Per the "only local models can read files" setting or the user's choice, it was not sent to the current model.)`

// GuardOutboundMessages 原地改写 messages（[]map[string]any，content 为字符串的才处理）
func GuardOutboundMessages(messages any, check OutboundCheck) error {
	list, ok := messages.([]map[string]any)
	if !ok {
		return nil
	}
	lastUser := -1
	for i := len(list) - 1; i >= 0; i-- {
		if list[i] != nil && list[i]["role"] == "user" {
			lastUser = i
			break
		}
	}
	cache := map[string]SendVerdict{}
	verdict := func(what string) SendVerdict {
		if v, ok := cache[what]; ok {
			return v
		}
		v := check(what)
		cache[what] = v
		return v
	}
	fileWhat := tr.T("electron.common.file-contents")
	cliWhat := tr.T("electron.common.coding-assistant-output")
	if lastUser >= 0 {
		if cur, ok := list[lastUser]["content"].(string); ok && reFileBody.MatchString(cur) {
			switch verdict(fileWhat) {
			case "local_only":
				return errors.New(tr.T("electron.common.local-only-attachment-blocked"))
			case "user_denied":
				return errors.New(tr.T("electron.common.cancelled-attachment-not-sent"))
			}
		}
	}
	for i, m := range list {
		if i == lastUser || m == nil {
			continue
		}
		content, ok := m["content"].(string)
		if !ok {
			continue
		}
		if reFileBody.MatchString(content) && verdict(fileWhat) != "" {
			content = reFileBody.ReplaceAllString(content, "<attached-file ${1}>\n"+withheld+"\n</attached-file>")
		}
		if reCliOutput.MatchString(content) && verdict(cliWhat) != "" {
			content = reCliOutput.ReplaceAllLiteralString(content, "<cli-output>\n"+withheld+"\n</cli-output>")
		}
		m["content"] = content
	}
	return nil
}

// IslandNotice 对应 islandNotice.ts
type IslandNotice struct {
	Kind       string `json:"kind"` // message | agent | reminder | info
	Title      string `json:"title"`
	Body       string `json:"body,omitempty"`
	DurationMs *int   `json:"durationMs,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	Status     string `json:"status,omitempty"` // done | failed | attention | running
}
