package askuser

import (
	"fmt"
	"strings"
)

// Format：交回模型的文字。跳过和超时让它按最稳妥的做法继续，不要再问同样的问题。
func Format(questions []Question, res Result) string {
	switch res.Action {
	case ActionSkip:
		return "用户跳过了这些问题。请按你的判断继续，并在回复里说明你的假设。不要再问同样的问题。"
	case ActionTimeout:
		return "用户没有在时限内回答。请按最稳妥的做法继续，并说明你的假设。不要再问同样的问题。"
	case ActionCancel:
		return "用户取消了这一轮。不要继续追问，也不要接着做还没确认的事。"
	}
	var b strings.Builder
	b.WriteString("用户的回答：")
	for i, q := range questions {
		a := answerOf(res.Answers, q.ID)
		fmt.Fprintf(&b, "\n%d. %s", i+1, q.Prompt)
		chosen := chosenLabels(q, a.Selected)
		custom := strings.TrimSpace(a.Custom)
		switch {
		case len(chosen) > 0 && custom != "":
			fmt.Fprintf(&b, "\n   选择：%s；自己写的：%s", strings.Join(chosen, "、"), custom)
		case len(chosen) > 0:
			fmt.Fprintf(&b, "\n   选择：%s", strings.Join(chosen, "、"))
		case custom != "":
			fmt.Fprintf(&b, "\n   自己写的：%s", custom)
		default:
			b.WriteString("\n   （这一问没有选）")
		}
	}
	if d := strings.TrimSpace(res.Details); d != "" {
		b.WriteString("\n补充说明：")
		b.WriteString(d)
	}
	return b.String()
}

func answerOf(answers []Answer, id string) Answer {
	for _, a := range answers {
		if a.QuestionID == id {
			return a
		}
	}
	return Answer{}
}

func chosenLabels(q Question, ids []string) []string {
	label := map[string]string{}
	for _, o := range q.Options {
		label[o.ID] = o.Label
	}
	var out []string
	seen := map[string]bool{}
	for _, id := range ids {
		l, ok := label[id]
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, l)
	}
	return out
}
