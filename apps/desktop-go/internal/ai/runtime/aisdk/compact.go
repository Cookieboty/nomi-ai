package aisdk

// compact.go：工具循环自动续轮时缩短较早的工具输出。
// 长任务里读文件、跑测试的输出会越积越多，把上下文撑满；换轮时只留最近几次工具结果的全文，
// 更早的大段输出保留开头一截并注明省略了多少——模型需要时可以再读一次。
// 只改这一轮循环里新产生的消息（from 之后），不动用户的历史；不改原对象（返回新列表）。

import (
	"fmt"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// compactKeepRecent：换轮时保留全文的最近几条工具消息（每条 = 一步里的全部工具结果）
const compactKeepRecent = 6

// compactMaxRunes：较早的工具输出超过这个长度就缩短；compactHeadRunes：缩短后保留的开头
const (
	compactMaxRunes  = 1500
	compactHeadRunes = 600
)

// CompactToolResults：messages[from:] 里除最近 keep 条之外的工具消息，超长的输出缩短
func CompactToolResults(messages []*u.Obj, from, keep int) []*u.Obj {
	if from < 0 {
		from = 0
	}
	var toolIdx []int
	for i := from; i < len(messages); i++ {
		if messages[i] != nil && messages[i].Get("role") == "tool" {
			toolIdx = append(toolIdx, i)
		}
	}
	if len(toolIdx) <= keep {
		return messages
	}
	out := append([]*u.Obj{}, messages...)
	for _, i := range toolIdx[:len(toolIdx)-keep] {
		if m := compactToolMessage(messages[i]); m != nil {
			out[i] = m
		}
	}
	return out
}

// compactToolMessage：缩短一条工具消息里的超长结果；没有要缩短的返回 nil
func compactToolMessage(m *u.Obj) *u.Obj {
	parts, ok := m.Get("content").([]any)
	if !ok {
		return nil
	}
	changed := false
	next := make([]any, len(parts))
	for j, p := range parts {
		next[j] = p
		part, ok := p.(*u.Obj)
		if !ok || part.Get("type") != "tool-result" {
			continue
		}
		out, ok := part.Get("output").(*u.Obj)
		if !ok {
			continue
		}
		var text string
		switch out.Get("type") {
		case "text", "error-text":
			text, _ = out.Get("value").(string)
		case "json":
			text = u.Stringify(out.Get("value"))
		default:
			continue
		}
		r := []rune(text)
		if len(r) <= compactMaxRunes {
			continue
		}
		kind := "text"
		if out.Get("type") == "error-text" {
			kind = "error-text"
		}
		short := string(r[:compactHeadRunes]) +
			fmt.Sprintf("\n…[较早的工具输出已省略 %d 字；需要时重新读取]", len(r)-compactHeadRunes)
		cp := part.Clone()
		cp.Set("output", u.NewObj("type", kind, "value", short))
		next[j] = cp
		changed = true
	}
	if !changed {
		return nil
	}
	return m.Clone().Set("content", next)
}
