package delegate

// 对话里「这件事要不要派出去」的判断规则（docs/features/scheduling-calendar.md）：每轮用户对话请求发出前追加到系统提示。
// 由内核统一追加，用户自定义了系统提示也生效；文字固定不变，不打断前缀缓存。
// 后台任务的执行（extra.taskId）与编程助手标签里的调用（extra.callerTabId）不加。
// 文字由 intent_hint_test.go 钉住。

import (
	"errors"
	"strings"
)

// DispatchHint = DISPATCH_HINT
var DispatchHint = strings.Join([]string{
	"判断这件事要现在做还是派出去：",
	"- 一两步就能做完的（回答问题、改一段话、生成一两张图、查一个事实），直接做，不要派。",
	"- 要做一阵子的，用 delegate_to_nomi 交给后台的 Nomi：一组图（3 张以上或多种风格）、PPT / 长文档 / 调研报告、批量整理文件、要多轮搜索比对的、明显要几分钟以上的；用户说「后台做」「做好叫我」「不急」「慢慢做」也派。派完用一句话告诉用户已经派出去、做完会回到这个对话，这一轮不要自己再做一遍。",
	"- 用户说「现在就要」「我等着」「就在这里做」，直接做，不派。",
	"- 纯写代码、改仓库交给编程助手（delegate_to_cli）；既有代码又有别的产出（比如做个网站还要配图写文案），派给后台的 Nomi，它会自己再分。",
	"- 以后某个时间做、定期做、某件事发生时再做，用 task_propose 起草持续任务；只是到点提醒用 reminder_create。",
	"- 拿不准时看做完要不要超过一两分钟：超过就派。用户问派出去的事进度如何或要停下，用 delegate_status / delegate_stop。",
}, "\n")

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
			m["content"] = c + "\n\n" + DispatchHint
			return true, nil
		}
	}
	options["messages"] = append([]any{map[string]any{"role": "system", "content": DispatchHint}}, msgs...)
	return true, nil
}
