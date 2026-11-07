package aisdk

// 上下文分项（同 Claude Code 的 /context：系统提示、工具定义、记忆、消息分开计），加起来等于真实占用。
//
// 各部分先按实际发出的请求估算 token，再用真实用量校准：
//   - 这一轮第一次请求的真实输入 → 校准「系统提示 + 工具定义 + 记忆 + 之前的对话 + 本轮输入」；
//   - 最后一次请求的输入 + 输出 − 第一次请求的输入 → 校准这一轮工具循环新增的部分（工具调用与结果、回复、思考）。
// 本地估算对代码 / JSON 偏低，只用它定比例，总量以供应商报回的为准。

import (
	"math"
	"strings"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 粗估：CJK 一字一 token，其余约 4 字符一 token（同 facade.EstimateTokens）
func estTokens(s string) float64 {
	if s == "" {
		return 0
	}
	w, n := 0, 0
	for _, c := range utf16.Encode([]rune(s)) {
		if (c >= 0x3000 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) ||
			(c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef) {
			w++
		} else {
			n++
		}
	}
	return float64(w + (n+3)/4)
}

type breakdown struct{ System, ToolDefs, Memory, User, Assistant, Tools, Thinking float64 }

func (b breakdown) sum() float64 {
	return b.System + b.ToolDefs + b.Memory + b.User + b.Assistant + b.Tools + b.Thinking
}

func (b breakdown) plus(o breakdown) breakdown {
	return breakdown{b.System + o.System, b.ToolDefs + o.ToolDefs, b.Memory + o.Memory, b.User + o.User,
		b.Assistant + o.Assistant, b.Tools + o.Tools, b.Thinking + o.Thinking}
}

// scaled：按比例放缩到 target；估不出比例时整块记在 fallback 上
func (b breakdown) scaled(target float64, fallback *float64) breakdown {
	if target <= 0 {
		return breakdown{}
	}
	s := b.sum()
	if s <= 0 {
		out := breakdown{}
		*fallback = target
		return out
	}
	k := target / s
	return breakdown{b.System * k, b.ToolDefs * k, b.Memory * k, b.User * k, b.Assistant * k, b.Tools * k, b.Thinking * k}
}

// addMessages：ModelMessage 按内容分类（用户文本 / 助手文本 / 工具调用与结果 / 思考）
func (b *breakdown) addMessages(msgs []*u.Obj) {
	for _, m := range msgs {
		if m == nil {
			continue
		}
		role, _ := m.Get("role").(string)
		if s, ok := m.Get("content").(string); ok {
			switch role {
			case "user":
				b.User += estTokens(s)
			case "assistant":
				b.Assistant += estTokens(s)
			case "system":
				b.System += estTokens(s)
			}
			continue
		}
		parts, _ := m.Get("content").([]any)
		for _, x := range parts {
			p, _ := x.(*u.Obj)
			if p == nil {
				continue
			}
			switch p.Get("type") {
			case "text":
				t, _ := p.Get("text").(string)
				if role == "user" {
					b.User += estTokens(t)
				} else {
					b.Assistant += estTokens(t)
				}
			case "reasoning":
				t, _ := p.Get("text").(string)
				b.Thinking += estTokens(t)
			case "tool-call":
				b.Tools += estTokens(p.Get("toolName").(string)) + estTokens(u.Stringify(p.Get("input")))
			case "tool-result":
				b.Tools += estTokens(u.Stringify(p.Get("output")))
			case "image", "file":
				b.User += 1000 // 图片按经验值（各家计法不同）
			}
		}
	}
}

// inputBreakdown：一次请求的输入分项（估算）。memory = 这次请求里用户消息带的长期记忆（已拼进用户文本）
func inputBreakdown(instructions *string, ts []Tool, msgs []*u.Obj, memory float64) breakdown {
	b := breakdown{}
	if instructions != nil {
		b.System = estTokens(*instructions)
	}
	for _, t := range ts {
		d := ""
		if t.Description != nil {
			d = *t.Description
		}
		b.ToolDefs += estTokens(t.Name) + estTokens(d) + estTokens(u.Stringify(t.InputSchema))
	}
	b.addMessages(msgs)
	if memory > b.User {
		memory = b.User
	}
	b.Memory, b.User = memory, b.User-memory
	return b
}

// memoryTokens：请求里用户消息带的长期记忆（ChatMessage.Context）
func memoryTokens(msgs []llm.ChatMessage) float64 {
	n := 0.0
	for _, m := range msgs {
		if m.Role == "user" {
			if c := strings.TrimSpace(m.Context); c != "" {
				n += estTokens(c)
			}
		}
	}
	return n
}

// contextBreakdown：校准后的分项（加起来 = total）。firstPrompt 为这一轮第一次请求的真实输入；拿不到时整体按比例
func contextBreakdown(base, growth breakdown, firstPrompt, total float64) *llm.ContextBreakdown {
	if total <= 0 {
		return nil
	}
	var out breakdown
	var extra float64
	if firstPrompt > 0 && firstPrompt <= total {
		out = base.scaled(firstPrompt, &extra)
		out.System += extra
		extra = 0
		g := growth.scaled(total-firstPrompt, &extra)
		g.Assistant += extra
		out = out.plus(g)
	} else {
		out = base.plus(growth).scaled(total, &extra)
		out.System += extra
	}
	r := func(f float64) float64 { return math.Round(f) }
	bd := &llm.ContextBreakdown{System: r(out.System), ToolDefs: r(out.ToolDefs), Memory: r(out.Memory),
		User: r(out.User), Assistant: r(out.Assistant), Tools: r(out.Tools), Thinking: r(out.Thinking)}
	// 四舍五入的差额记在最大的一项上，保证加起来正好等于 total
	diff := total - (bd.System + bd.ToolDefs + bd.Memory + bd.User + bd.Assistant + bd.Tools + bd.Thinking)
	if diff != 0 {
		ptrs := []*float64{&bd.System, &bd.ToolDefs, &bd.Memory, &bd.User, &bd.Assistant, &bd.Tools, &bd.Thinking}
		big := ptrs[0]
		for _, p := range ptrs {
			if *p > *big {
				big = p
			}
		}
		*big += diff
	}
	return bd
}
