package igtools

// ask_user：模型拿不准时问用户，这一轮停在这里，直到用户回答、跳过、取消或超时。
// 问题卡在对话输入栏上方（契约 ai.userQuestion）。后台任务不提供这个工具（tasks.ConversationExcluded）。

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/askuser"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const askUserSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{` +
	`"questions":{"type":"array","minItems":1,"maxItems":4,"description":"要用户决定的问题，1 到 4 个，按这个顺序一张张问",` +
	`"items":{"type":"object","properties":{` +
	`"question":{"type":"string","minLength":1,"maxLength":500,"description":"问题本身，一句话"},` +
	`"header":{"type":"string","maxLength":40,"description":"可选的短标题，四个字以内最好"},` +
	`"multi":{"type":"boolean","description":"true 时可多选；不传就是单选"},` +
	`"options":{"type":"array","maxItems":6,"description":"供选择的选项。可以不给，用户仍然可以自己写",` +
	`"items":{"type":"object","properties":{` +
	`"label":{"type":"string","minLength":1,"maxLength":200,"description":"选项文字"},` +
	`"description":{"type":"string","maxLength":300,"description":"可选的一句说明"}},` +
	`"required":["label"],"additionalProperties":false}}},` +
	`"required":["question"],"additionalProperties":false}}},` +
	`"required":["questions"],"additionalProperties":false}`

// 测试替换经纪人；生产由 wireAskUser 设置。
var askBroker *askuser.Broker

// SetAskBroker：接上问题经纪人。返回原来的，测试用来还原。
func SetAskBroker(b *askuser.Broker) *askuser.Broker {
	prev := askBroker
	askBroker = b
	return prev
}

// AskUserTool：ask_user
func AskUserTool() tools.Definition {
	return tools.Definition{
		Name: "ask_user",
		Description: "向用户提一个或多个选择题，等用户回答后再继续。拿不准偏好、范围、方案取舍时用它，不要替用户猜。" +
			"每次 1 到 4 个问题；每个问题最多 6 个选项，也可以不给选项让用户自己写。multi 为 true 时可多选。" +
			"用户可以跳过或自己写答案；跳过、取消或超时就按最稳妥的做法继续，并说明你的假设。不要重复问刚问过的问题。",
		Input:          schema(askUserSchema),
		DangerousUnset: true,
		Execute:        execAskUser,
	}
}

func execAskUser(ctx context.Context, in any, ec tools.ExecContext) (any, error) {
	if askBroker == nil {
		return nil, errAskUnavailable
	}
	qs, err := parseAskUser(in)
	if err != nil {
		return nil, err
	}
	conv := strings.TrimSpace(ec.ConversationID)
	if conv == "" {
		conv = tools.ConversationFrom(ctx)
	}
	if conv == "" {
		return "没有对话界面可以提问。请直接做决定，并在回复里说明你的假设。", nil
	}
	res, err := askBroker.Ask(ctx, conv, qs)
	if err != nil {
		return nil, err
	}
	return askuser.Format(qs, res), nil
}

var errAskUnavailable = errString("ask_user is unavailable")

type errString string

func (e errString) Error() string { return string(e) }

func parseAskUser(in any) ([]askuser.Question, error) {
	o, _ := in.(*u.Obj)
	if o == nil {
		return nil, errString("ask_user: questions is required")
	}
	raw, _ := o.Get("questions").([]any)
	if len(raw) == 0 {
		return nil, errString("ask_user: questions is required")
	}
	if len(raw) > 4 {
		raw = raw[:4]
	}
	out := make([]askuser.Question, 0, len(raw))
	for i, x := range raw {
		item, _ := x.(*u.Obj)
		if item == nil {
			return nil, errString("ask_user: each question must be an object")
		}
		prompt := clipRunes(strings.TrimSpace(strOf(item.Get("question"))), 500)
		if prompt == "" {
			return nil, errString("ask_user: question is empty")
		}
		opts, err := parseAskOptions(item.Get("options"))
		if err != nil {
			return nil, err
		}
		out = append(out, askuser.Question{
			ID:      "q" + itoaSmall(i+1),
			Prompt:  prompt,
			Header:  clipRunes(strings.TrimSpace(strOf(item.Get("header"))), 40),
			Multi:   item.Get("multi") == true,
			Options: opts,
		})
	}
	return out, nil
}

func parseAskOptions(v any) ([]askuser.Option, error) {
	if v == nil {
		return []askuser.Option{}, nil
	}
	raw, ok := v.([]any)
	if !ok {
		return nil, errString("ask_user: options must be an array")
	}
	if len(raw) > 6 {
		raw = raw[:6]
	}
	out := make([]askuser.Option, 0, len(raw))
	for _, x := range raw {
		o, _ := x.(*u.Obj)
		if o == nil {
			return nil, errString("ask_user: each option must be an object")
		}
		label := clipRunes(strings.TrimSpace(strOf(o.Get("label"))), 200)
		if label == "" {
			return nil, errString("ask_user: option label is empty")
		}
		n := len(out)
		id := "o"
		if n < 26 {
			id = string(rune('a' + n))
		}
		out = append(out, askuser.Option{
			ID:          id,
			Label:       label,
			Description: clipRunes(strings.TrimSpace(strOf(o.Get("description"))), 300),
		})
	}
	return out, nil
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func itoaSmall(n int) string {
	if n >= 0 && n < 10 {
		return string(rune('0' + n))
	}
	return "0"
}
