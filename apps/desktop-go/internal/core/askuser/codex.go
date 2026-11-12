package askuser

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CodexUserInput：Codex app-server item/tool/requestUserInput 里能画到问题卡上的部分。
// IDs 与 Questions 一一对应，是协议里的问题 id（写回答时用），不是卡片上的 q1、q2。
type CodexUserInput struct {
	Questions []Question
	IDs       []string
}

// QuestionsFromCodex：解析 item/tool/requestUserInput 的 params。
// 机密问题（isSecret）不进卡片。一个都画不出来时 ok 为 false，调用方回空答案，避免这一轮挂住。
func QuestionsFromCodex(params *util.Obj) (CodexUserInput, bool) {
	if params == nil {
		return CodexUserInput{}, false
	}
	raw, _ := params.Get("questions").([]any)
	if len(raw) == 0 {
		return CodexUserInput{}, false
	}
	out := CodexUserInput{}
	for _, x := range raw {
		if len(out.Questions) >= maxQuestions {
			break
		}
		o := util.AsObj(x)
		if o == nil || !util.IsObj(x) {
			continue
		}
		if o.Get("isSecret") == true || o.Get("is_secret") == true {
			continue
		}
		prompt := clip(strings.TrimSpace(util.Str(o.Get("question"))), maxPrompt)
		if prompt == "" {
			continue
		}
		id := strings.TrimSpace(util.Str(o.Get("id")))
		if id == "" {
			id = "q" + itoa(len(out.Questions)+1)
		}
		out.Questions = append(out.Questions, Question{
			ID:      "q" + itoa(len(out.Questions)+1),
			Prompt:  prompt,
			Header:  clip(strings.TrimSpace(util.Str(o.Get("header"))), maxHeader),
			Options: codexOptions(o.Get("options")),
		})
		out.IDs = append(out.IDs, id)
	}
	if len(out.Questions) == 0 {
		return CodexUserInput{}, false
	}
	return out, true
}

func codexOptions(v any) []Option {
	raw, _ := v.([]any)
	out := []Option{}
	for _, x := range raw {
		if len(out) >= maxOptions {
			break
		}
		o := util.AsObj(x)
		if !util.IsObj(x) {
			continue
		}
		label := clip(strings.TrimSpace(util.Str(o.Get("label"))), maxLabel)
		if label == "" {
			label = clip(strings.TrimSpace(util.Str(o.Get("value"))), maxLabel)
		}
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

// CodexUserInputResult：写回 item/tool/requestUserInput 的结果。
// 回答是 {answers:{问题 id:{answers:[选项文字…]}}}，补充说明写成 user_note（与 Codex TUI 相同）。
// 跳过和超时都是空 answers（Codex 自己超时也是交空答案，这一轮继续）。
// 取消没有结果体：cancel 为真，调用方用 JSON-RPC 错误结束这次请求，模型才知道是被取消而不是没选。
func CodexUserInputResult(in CodexUserInput, res Result) (body *util.Obj, cancel bool) {
	if res.Action == ActionCancel {
		return nil, true
	}
	answers := util.NewObj()
	if res.Action == ActionAnswer {
		details := strings.TrimSpace(res.Details)
		noted := false
		for i, q := range in.Questions {
			if i >= len(in.IDs) {
				break
			}
			lines := codexAnswerLines(q, answerOf(res.Answers, q.ID))
			if len(lines) > 0 && !noted && details != "" {
				lines = append(lines, "user_note: "+details)
				noted = true
			}
			if len(lines) == 0 {
				continue
			}
			arr := make([]any, len(lines))
			for j, line := range lines {
				arr[j] = line
			}
			answers.Set(in.IDs[i], util.NewObj("answers", arr))
		}
		if !noted && details != "" && len(in.IDs) > 0 {
			answers.Set(in.IDs[0], util.NewObj("answers", []any{"user_note: " + details}))
		}
	}
	return util.NewObj("answers", answers), false
}

func codexAnswerLines(q Question, a Answer) []string {
	labels := chosenLabels(q, a.Selected)
	custom := strings.TrimSpace(a.Custom)
	if q.Multi {
		out := append([]string{}, labels...)
		if custom != "" {
			out = append(out, custom)
		}
		return out
	}
	if custom != "" {
		return []string{custom}
	}
	if len(labels) > 0 {
		return []string{labels[0]}
	}
	return nil
}
