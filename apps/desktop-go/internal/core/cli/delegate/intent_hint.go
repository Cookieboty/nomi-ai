package delegate

// 对话里「这件事要不要派出去」的判断规则（docs/features/scheduling-calendar.md）：每轮用户对话请求发出前追加到系统提示。
// 由内核统一追加，用户自定义了系统提示也生效；文字只随「有没有能委派的编程助手」变（codingcli），平时不打断前缀缓存。
// 后台任务的执行（extra.taskId）与编程助手标签里的调用（extra.callerTabId）不加。
// 文字在 prompts/text/dispatch-hint.md。

import (
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codingcli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
)

// DispatchHintFor：hasCli = 本机有能委派的编程助手；没有时改成让 Nomi 自己写代码
func DispatchHintFor(hasCli bool) string {
	return prompts.Render("dispatch-hint", map[string]any{"HasCli": hasCli})
}

// DispatchHint：有编程助手时的规则（测试与快照用）
var DispatchHint = DispatchHintFor(true)

// ApplyDispatchHint = applyDispatchHint（就地改写 options）：用户对话的请求追加判断规则；
// 后台任务执行、编程助手标签里的调用不加。返回是否追加了
func ApplyDispatchHint(options map[string]any) (bool, error) {
	if extra, ok := options["extra"].(map[string]any); ok {
		if _, isStr := extra["taskId"].(string); isStr {
			return false, nil
		}
		if _, isStr := extra["callerTabId"].(string); isStr {
			return false, nil
		}
	}
	msgs, ok := options["messages"].([]any)
	if !ok {
		return false, nil
	}
	hint := DispatchHintFor(codingcli.Available())
	for _, x := range msgs {
		if x == nil {
			// m.role 读 null 抛 TypeError
			return false, errors.New("Cannot read properties of null (reading 'role')")
		}
		m, _ := x.(map[string]any)
		if m == nil || m["role"] != "system" {
			continue
		}
		if c, ok := m["content"].(string); ok {
			m["content"] = c + "\n\n" + hint
			return true, nil
		}
	}
	options["messages"] = append([]any{map[string]any{"role": "system", "content": hint}}, msgs...)
	return true, nil
}
