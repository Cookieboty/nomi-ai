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
	// 本地数据工具结果里的正文：fs_read_text / fs_summarize 的文件（WrapUntrusted）、workspace_run / code_run 的
	// 命令输出（WrapCommandOutput）、browser_read 的网页（WrapWeb）。调用时都按当时的接收者做过 beforeSend，
	// 回放给别的接收者时要重新判断；没闭合（被截断）时挡到结尾。RE2 没有反向引用，一种标签一条
	reToolData = []*regexp.Regexp{
		toolDataRe("file_content"),
		toolDataRe("command_output"),
		toolDataRe("web_content"),
	}
)

func toolDataRe(tag string) *regexp.Regexp {
	return regexp.MustCompile(`<` + tag + `\b([^\n>]*)>?([\s\S]*?)(?:</` + tag + `>|$)`)
}

var toolDataTags = []string{"<file_content", "<command_output", "<web_content"}

const withheld = `(Content withheld: shown only on this device. Per the "only local models can read files" setting or the user's choice, it was not sent to the current model.)`

const withheldBody = "\n" + withheld + "\n"

// hasToolData：有没有还没换成占位的工具正文（只剩占位的不再问接收者）
func hasToolData(s string) bool {
	for _, re := range reToolData {
		for _, m := range re.FindAllStringSubmatch(s, -1) {
			if m[2] != withheldBody {
				return true
			}
		}
	}
	return false
}

func withholdToolData(s string) string {
	for i, re := range reToolData {
		tag := toolDataTags[i][1:]
		s = re.ReplaceAllStringFunc(s, func(m string) string {
			g := re.FindStringSubmatch(m)
			return "<" + tag + g[1] + ">" + withheldBody + "</" + tag + ">"
		})
	}
	return s
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
			// 之前用本地模型读的文件 / 跑的命令 / 读的网页，会话换到云端模型后按本轮接收者重新判断（同一请求和附件共用一次确认）
			if hasToolData(content) && verdict(fileWhat) != "" {
				content = withholdToolData(content)
			}
			return content
		}
		// 上一轮的工具记录（工具结果里也可能有附件正文 / 编程助手输出 / 读过的文件、命令输出、网页）：同样处理，没改动时原样保留
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
	if !strings.Contains(steps, "<attached-file ") && !strings.Contains(steps, "<cli-output>") && !containsAny(steps, toolDataTags) {
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

func containsAny(s string, subs []string) bool {
	for _, x := range subs {
		if strings.Contains(s, x) {
			return true
		}
	}
	return false
}

// IslandNotice：灵动岛通知
type IslandNotice struct {
	Kind       string `json:"kind"` // message | agent | reminder | info
	Title      string `json:"title"`
	Body       string `json:"body,omitempty"`
	DurationMs *int   `json:"durationMs,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	Status     string `json:"status,omitempty"` // done | failed | attention | running
	// Session：通知所属的会话（标签 id，主对话 "main"；不属于会话为 ""），决定显示与否用（island.ShouldShow）
	Session string `json:"-"`
}
