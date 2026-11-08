package desktop

import (
	"errors"
	"regexp"
	"strings"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 外发给云端模型前，把附件正文 / 编码助手输出按设置挡下或替换

type SendVerdict = string // "" | local_only | user_denied

type OutboundCheck func(what string) SendVerdict

var (
	reFileBody  = regexp.MustCompile(`<attached-file (name="[^"]*"(?: path="[^"]*")?)>\n[\s\S]*?\n</attached-file>`)
	reCliOutput = regexp.MustCompile(`<cli-output>[\s\S]*?</cli-output>`)
	// 本地文件工具（fs_read_text / fs_summarize）结果里的文件正文（WrapUntrusted）；没闭合（被截断）时挡到结尾
	reToolFile = regexp.MustCompile(`<file_content\b([^\n>]*)>?([\s\S]*?)(?:</file_content>|$)`)
)

const withheld = `(Content withheld: shown only on this device. Per the "only local models can read files" setting or the user's choice, it was not sent to the current model.)`

const withheldBody = "\n" + withheld + "\n"

// hasToolFile：有没有还没换成占位的 <file_content> 正文（只剩占位的不再问接收者）
func hasToolFile(s string) bool {
	for _, m := range reToolFile.FindAllStringSubmatch(s, -1) {
		if m[2] != withheldBody {
			return true
		}
	}
	return false
}

func withholdToolFile(s string) string {
	return reToolFile.ReplaceAllStringFunc(s, func(m string) string {
		g := reToolFile.FindStringSubmatch(m)
		return "<file_content" + g[1] + ">" + withheldBody + "</file_content>"
	})
}

// GuardOutboundMessages 原地改写 messages（[]map[string]any，content 为字符串的才处理）
func GuardOutboundMessages(messages any, check OutboundCheck) error {
	var list []map[string]any
	nullAt := -1 // list[i]! 为 null 时读 .content 抛 TypeError
	switch v := messages.(type) {
	case []map[string]any:
		list = v
	case []any: // JSON 解码出的数组（Array.isArray）
		list = make([]map[string]any, len(v))
		for i, x := range v {
			if x == nil && nullAt < 0 {
				nullAt = i
			}
			list[i], _ = x.(map[string]any)
		}
	default:
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
		if i == lastUser {
			continue
		}
		if i == nullAt {
			return errors.New("Cannot read properties of null (reading 'content')")
		}
		if m == nil {
			continue
		}
		scrub := func(content string) string {
			if reFileBody.MatchString(content) && verdict(fileWhat) != "" {
				content = reFileBody.ReplaceAllString(content, "<attached-file ${1}>\n"+withheld+"\n</attached-file>")
			}
			if reCliOutput.MatchString(content) && verdict(cliWhat) != "" {
				content = reCliOutput.ReplaceAllLiteralString(content, "<cli-output>\n"+withheld+"\n</cli-output>")
			}
			// 之前用本地模型读的文件，会话换到云端模型后按本轮接收者重新判断（同一请求和附件共用一次确认）
			if hasToolFile(content) && verdict(fileWhat) != "" {
				content = withholdToolFile(content)
			}
			return content
		}
		// 上一轮的工具记录（工具结果里也可能有附件正文 / 编程助手输出 / 读过的文件）：同样处理，没改动时原样保留
		if steps, ok := m["steps"].(string); ok && steps != "" {
			m["steps"] = scrubSteps(steps, scrub)
		}
		content, ok := m["content"].(string)
		if !ok {
			continue
		}
		m["content"] = scrub(content)
	}
	return nil
}

// scrubSteps：对工具记录里的每个字符串套用 scrub；有改动才重新序列化（键序不变），解析不了时原样返回
func scrubSteps(steps string, scrub func(string) string) string {
	if !strings.Contains(steps, "<attached-file ") && !strings.Contains(steps, "<cli-output>") && !strings.Contains(steps, "<file_content") {
		return steps
	}
	v, err := util.ParseString(steps)
	if err != nil {
		return steps
	}
	changed := false
	var walk func(x any) any
	walk = func(x any) any {
		switch t := x.(type) {
		case string:
			if s := scrub(t); s != t {
				changed = true
				return s
			}
		case []any:
			for i := range t {
				t[i] = walk(t[i])
			}
		case *util.Obj:
			for _, k := range t.Keys() {
				t.Set(k, walk(t.Get(k)))
			}
		}
		return x
	}
	v = walk(v)
	if !changed {
		return steps
	}
	return util.Stringify(v)
}

// IslandNotice：灵动岛通知
type IslandNotice struct {
	Kind       string `json:"kind"` // message | agent | reminder | info
	Title      string `json:"title"`
	Body       string `json:"body,omitempty"`
	DurationMs *int   `json:"durationMs,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	Status     string `json:"status,omitempty"` // done | failed | attention | running
}
