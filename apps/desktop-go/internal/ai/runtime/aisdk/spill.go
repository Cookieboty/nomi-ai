package aisdk

// spill.go：大段工具输出先暂存，模型只看开头和结尾，需要时用 tool_output_read 分页读。
// 每次调用的输出都进上下文、之后每一步都带着：一次读出几万字，后面每一步都为它付费。
// - 只在内存里存（进程重启后失效，模型重新执行原工具即可），按对话隔离：别的对话读不到。
// - 原输出带着外发保护认的标记（<file_content> / <command_output> / <web_content>）时，分页读出的每一段也包上
//   同样的标记：会话换到不允许读文件的模型时，回放保护照样能挡下（desktop/outbound_guard.go）；读之前还按这一次的
//   实际接收者重新检查（tools.CheckDataSend）：换成云端模型后，没被历史保护挡到的分页 id 也读不出正文。
// - 视图要解析结构的工具（委派结果、生图、计划）不暂存。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	// SpillChars：工具输出超过这么多字（UTF-16 码元）就暂存
	SpillChars = 30_000
	// spillPreviewHead / spillPreviewTail：暂存时模型直接看到的开头 / 结尾
	spillPreviewHead = 6_000
	spillPreviewTail = 4_000
	spillPageDefault = 8_000
	spillPageMax     = 20_000
	// spillMaxBytes：所有暂存加起来最多占多少（旧的先丢）
	spillMaxBytes = 32 << 20
	// OutputReadTool：分页读暂存输出的工具名
	OutputReadTool = "tool_output_read"
)

// 视图要解析结构的工具：不暂存
var noSpill = map[string]bool{
	"delegate_to_cli": true, "delegate_status": true, "delegate_followup": true, "delegate_to_nomi": true,
	"delegate_stop": true, "image_generate": true, "plan_update": true, OutputReadTool: true,
}

type spillEntry struct {
	id, conv string
	text     []uint16
	tag      string // 原输出里外发保护认的标记（file_content / command_output / web_content）；空 = 没有
}

type spillStore struct {
	mu    sync.Mutex
	items map[string]*spillEntry
	order []string
	bytes int
}

var spills = &spillStore{items: map[string]*spillEntry{}}

func (s *spillStore) put(e *spillEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[e.id] = e
	s.order = append(s.order, e.id)
	s.bytes += len(e.text) * 2
	for s.bytes > spillMaxBytes && len(s.order) > 1 {
		old := s.items[s.order[0]]
		if old != nil {
			s.bytes -= len(old.text) * 2
			delete(s.items, old.id)
		}
		s.order = s.order[1:]
	}
}

func (s *spillStore) get(id string) *spillEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items[id]
}

func newSpillID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "out_" + hex.EncodeToString(b)
}

// guardTag：输出里有没有外发保护认的标记（有就记下第一种，分页读出时包上同样的标记）
func guardTag(s string) string {
	for _, t := range []string{"file_content", "command_output", "web_content"} {
		if strings.Contains(s, "<"+t) {
			return t
		}
	}
	return ""
}

func wrapTag(tag, text string) string {
	if tag == "" {
		return text
	}
	attr := ""
	if tag == "file_content" {
		attr = ` path="(earlier tool output)"`
	}
	return "<" + tag + attr + ` trust="untrusted">` + "\n" + text + "\n</" + tag + ">"
}

// spillOutput：输出太大时暂存，返回给模型的预览；不需要时原样返回
func spillOutput(tool, conv string, out any) any {
	if noSpill[tool] || out == nil {
		return out
	}
	var s string
	switch v := out.(type) {
	case string:
		s = v
	case u.JSUndefined:
		return out
	default:
		s = u.Stringify(v)
	}
	text := utf16.Encode([]rune(s))
	if len(text) <= SpillChars {
		return out
	}
	e := &spillEntry{id: newSpillID(), conv: conv, text: text, tag: guardTag(s)}
	spills.put(e)
	head := string(utf16.Decode(text[:spillPreviewHead]))
	tail := string(utf16.Decode(text[len(text)-spillPreviewTail:]))
	note := fmt.Sprintf("\n…[output too long: %d characters, the middle is omitted here. Read any part with %s(id=%q, offset, limit); offsets count characters from 0]…\n",
		len(text), OutputReadTool, e.id)
	return wrapTag(e.tag, head) + note + wrapTag(e.tag, tail)
}

const outputReadSchema = `{"type":"object","properties":{` +
	`"id":{"type":"string","description":"the id from the truncation note"},` +
	`"offset":{"type":"integer","minimum":0,"description":"start position in characters (0 = beginning)"},` +
	`"limit":{"type":"integer","minimum":1,"maximum":20000,"description":"how many characters to read (default 8000)"}},` +
	`"required":["id"],"additionalProperties":false}`

// outputReadTool：分页读暂存的输出（只能读这个对话里的）。recv：这一次实际接收结果的模型
func outputReadTool(conv string, recv *tools.ToolCallProvider) Tool {
	desc := "Read part of an earlier tool output that was too long and was cut down; the id and total length are in the truncation note."
	schema, _ := u.ParseString(outputReadSchema)
	return Tool{Name: OutputReadTool, Description: &desc, InputSchema: schema,
		Execute: func(ctx context.Context, input any, _ string) (any, error) {
			in, _ := input.(*u.Obj)
			id, _ := in.Get("id").(string)
			e := spills.get(id)
			if e == nil || (e.conv != "" && e.conv != conv) {
				return nil, fmt.Errorf("output %q is no longer available (outputs are kept only until Nomi restarts); run the original tool again", id)
			}
			// 本地数据（文件 / 命令输出 / 网页）：暂存时的接收者检查过，不代表现在这个接收者也可以读
			if e.tag != "" {
				if err := tools.CheckDataSend(ctx, recv); err != nil {
					return nil, err
				}
			}
			off, limit := 0, spillPageDefault
			if f, ok := in.Get("offset").(float64); ok && f > 0 {
				off = int(f)
			}
			if f, ok := in.Get("limit").(float64); ok && f > 0 {
				limit = min(int(f), spillPageMax)
			}
			if off >= len(e.text) {
				return fmt.Sprintf("(offset %d is past the end; total %d characters)", off, len(e.text)), nil
			}
			end := min(off+limit, len(e.text))
			page := string(utf16.Decode(e.text[off:end]))
			return fmt.Sprintf("[characters %d–%d of %d]\n", off, end, len(e.text)) + wrapTag(e.tag, page), nil
		}}
}
