package aisdk

// autoprogress.go：模型说「做完了」不等于事情做完了；自动续轮也不能原地打转。
// - 计划没做完就收尾：这一轮最近一次 plan_update 里还有 pending / in_progress 的步骤，模型却正常结束了，
//   提醒它接着做（或把做不了的标成 skipped 并说明），最多 MaxPlanNudges 次；上次提醒之后没有任何实际动作就不再提醒。
// - 续轮没有进展：步数用完要自动续轮，但这一轮除了 plan_update 没有调用任何别的工具，就停下（不再空转）。
// 「实际动作」= 调用了 plan_update 以外的工具，且这一轮之前没以同样的参数调用过；只改计划文字、
// 原样重复之前的调用都不算。

import (
	"fmt"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MaxPlanNudges：一轮里因为计划没做完最多提醒几次
var MaxPlanNudges = 2

const planTool = "plan_update"

type toolCall struct{ name, key string }

// toolCallsIn：消息里的工具调用（名字 + 名字与参数拼成的键）
func toolCallsIn(msgs []*u.Obj) []toolCall {
	var out []toolCall
	for _, m := range msgs {
		if m == nil || m.Get("role") != "assistant" {
			continue
		}
		parts, _ := m.Get("content").([]any)
		for _, x := range parts {
			if p, ok := x.(*u.Obj); ok && p.Get("type") == "tool-call" {
				if n, ok := p.Get("toolName").(string); ok {
					out = append(out, toolCall{n, n + "\x00" + u.Stringify(p.Get("input"))})
				}
			}
		}
	}
	return out
}

// madeProgress：这一轮（round）里有没有 plan_update 以外、之前（prev）没以同样参数调用过的工具调用
func madeProgress(prev, round []*u.Obj) bool {
	seen := map[string]bool{}
	for _, c := range toolCallsIn(prev) {
		seen[c.key] = true
	}
	for _, c := range toolCallsIn(round) {
		if c.name != planTool && !seen[c.key] {
			return true
		}
		seen[c.key] = true
	}
	return false
}

// unfinishedPlan：最近一次 plan_update 里还没做完的步骤；没有计划或都做完了返回 nil
func unfinishedPlan(msgs []*u.Obj) []string {
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m == nil || m.Get("role") != "assistant" {
			continue
		}
		parts, _ := m.Get("content").([]any)
		for j := len(parts) - 1; j >= 0; j-- {
			p, ok := parts[j].(*u.Obj)
			if !ok || p.Get("type") != "tool-call" || p.Get("toolName") != planTool {
				continue
			}
			in, _ := p.Get("input").(*u.Obj)
			if in == nil {
				return nil
			}
			items, _ := in.Get("items").([]any)
			var open []string
			for _, x := range items {
				it, ok := x.(*u.Obj)
				if !ok {
					continue
				}
				if st, _ := it.Get("status").(string); st == "pending" || st == "in_progress" {
					step, _ := it.Get("step").(string)
					open = append(open, strings.TrimSpace(step))
				}
			}
			return open
		}
	}
	return nil
}

// planNudge：提醒模型计划还没做完（给模型看，不随界面语言变化）
func planNudge(open []string) string {
	if len(open) > 8 {
		open = append(open[:8], fmt.Sprintf("… (%d more)", len(open)-8))
	}
	return "[Automatic reminder, not from the user] Your plan still has unfinished steps:\n- " + strings.Join(open, "\n- ") +
		"\nKeep going until they are done. If a step can't or shouldn't be done, mark it skipped with plan_update and say why; " +
		"if you need the user's decision, say so plainly and stop."
}
