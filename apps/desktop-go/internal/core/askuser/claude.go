package askuser

import (
	"strings"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	maxQuestions = 4
	maxOptions   = 6
	maxPrompt    = 500
	maxHeader    = 40
	maxLabel     = 200
	maxDesc      = 300
)

// QuestionsFromClaude：Claude Code AskUserQuestion 的 input.questions。
// 对不上（没有 questions 数组）时 ok 为 false，调用方改走普通的允许 / 拒绝。
func QuestionsFromClaude(in *util.Obj) ([]Question, bool) {
	if in == nil {
		return nil, false
	}
	raw, _ := in.Get("questions").([]any)
	if len(raw) == 0 {
		return nil, false
	}
	if len(raw) > maxQuestions {
		raw = raw[:maxQuestions]
	}
	out := make([]Question, 0, len(raw))
	for i, x := range raw {
		o := util.AsObj(x)
		if o == nil {
			continue
		}
		prompt := clip(strings.TrimSpace(util.Str(o.Get("question"))), maxPrompt)
		if prompt == "" {
			prompt = clip(strings.TrimSpace(util.Str(o.Get("prompt"))), maxPrompt)
		}
		if prompt == "" {
			continue
		}
		q := Question{
			ID:      "q" + itoa(i+1),
			Prompt:  prompt,
			Header:  clip(strings.TrimSpace(util.Str(o.Get("header"))), maxHeader),
			Multi:   o.Get("multiSelect") == true || o.Get("multi") == true,
			Options: optionsFrom(o.Get("options")),
		}
		out = append(out, q)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func optionsFrom(v any) []Option {
	raw, _ := v.([]any)
	if len(raw) > maxOptions {
		raw = raw[:maxOptions]
	}
	out := []Option{}
	for _, x := range raw {
		o := util.AsObj(x)
		if o == nil {
			continue
		}
		label := clip(strings.TrimSpace(util.Str(o.Get("label"))), maxLabel)
		if label == "" {
			continue
		}
		out = append(out, Option{
			ID:          letter(len(out)),
			Label:       label,
			Description: clip(strings.TrimSpace(util.Str(o.Get("description"))), maxDesc),
		})
	}
	return out
}

// ClaudeUpdatedInput：允许这次工具调用时写回的 input。answers 的键是问题原文，值是选项文字
// （多选用 ", " 接起来）；用户自己写的答案直接当这个值。补充说明附在第一条有内容的答案后面。
func ClaudeUpdatedInput(raw *util.Obj, questions []Question, res Result) *util.Obj {
	base := util.NewObj()
	if raw != nil {
		base = raw.Clone()
	}
	answers := util.NewObj()
	details := strings.TrimSpace(res.Details)
	attached := false
	for _, q := range questions {
		a := answerOf(res.Answers, q.ID)
		text := answerText(q, a)
		if text == "" && !attached && details != "" {
			text = details
			attached = true
		} else if text != "" && !attached && details != "" {
			text += "\n补充：" + details
			attached = true
		}
		if text != "" {
			answers.Set(q.Prompt, text)
		}
	}
	base.Set("answers", answers)
	return base
}

func answerText(q Question, a Answer) string {
	labels := chosenLabels(q, a.Selected)
	custom := strings.TrimSpace(a.Custom)
	if q.Multi {
		if custom != "" {
			labels = append(labels, custom)
		}
		return strings.Join(labels, ", ")
	}
	if custom != "" {
		return custom
	}
	if len(labels) > 0 {
		return labels[0]
	}
	return ""
}

func letter(i int) string {
	if i >= 0 && i < 26 {
		return string(rune('a' + i))
	}
	return "o" + itoa(i+1)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}
