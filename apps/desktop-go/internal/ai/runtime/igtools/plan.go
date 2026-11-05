package igtools

// plan_update：多步任务的计划清单。模型每次传完整的清单（步骤 + 状态），工具原样整理后交回，
// 计划就留在对话的工具记录里——长任务跨很多步、自动续轮（aisdk.MaxAutoRounds）、旧的工具输出被缩短之后，
// 模型仍能从最近一次计划看到做到哪了。不存盘、不碰文件，没有副作用。

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	planMaxItems = 50
	planMaxText  = 300
)

const planSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{` +
	`"items":{"type":"array","minItems":1,"maxItems":50,"description":"完整的计划清单（每次都传全部步骤，不是只传改动的）","items":{"type":"object","properties":{` +
	`"step":{"type":"string","minLength":1,"maxLength":300,"description":"这一步要做什么，一句话"},` +
	`"status":{"type":"string","enum":["pending","in_progress","done","skipped"],"description":"pending 未开始 / in_progress 正在做（同时只有一项）/ done 做完 / skipped 不做了"}},` +
	`"required":["step","status"],"additionalProperties":false}},` +
	`"note":{"type":"string","maxLength":500,"description":"可选：计划为什么变了、发现了什么"}},"required":["items"],"additionalProperties":false}`

var planMarks = map[string]string{"pending": "[ ]", "in_progress": "[>]", "done": "[x]", "skipped": "[-]"}

// PlanTool：plan_update
func PlanTool() tools.Definition {
	return tools.Definition{
		Name: "plan_update",
		Description: "记录 / 更新多步任务的计划清单（要改好几个文件、跑多轮测试、步骤超过三步的事先列计划）。" +
			"每次传完整清单；开始做一步时把它标成 in_progress，做完标 done，计划变了就改清单。" +
			"全部 done 之前不要收尾；工具步数用完会自动接着做。",
		Input:          schema(planSchema),
		DangerousUnset: true,
		Relevant:       planRelevant,
		Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
			return formatPlan(in)
		},
	}
}

// planRelevant：选了工作区，或对话里说到写代码 / 文件 / 委派这类多步的事时提供
func planRelevant(t tools.Turn) bool {
	return t.Cwd != "" || gateDelegate.MatchString(t.ConvoText) || gateFiles.MatchString(t.ConvoText)
}

func formatPlan(in any) (string, error) {
	o, ok := in.(*u.Obj)
	if !ok {
		return "", errors.New("plan_update: input must be an object with items")
	}
	raw, ok := o.Get("items").([]any)
	if !ok || len(raw) == 0 {
		return "", errors.New("plan_update: items is required")
	}
	if len(raw) > planMaxItems {
		raw = raw[:planMaxItems]
	}
	var b strings.Builder
	done, active := 0, 0
	lines := make([]string, 0, len(raw))
	for i, x := range raw {
		it, ok := x.(*u.Obj)
		if !ok {
			return "", fmt.Errorf("plan_update: items[%d] must be an object", i)
		}
		step, _ := it.Get("step").(string)
		step = strings.Join(strings.Fields(step), " ")
		if step == "" {
			return "", fmt.Errorf("plan_update: items[%d].step is empty", i)
		}
		if r := []rune(step); len(r) > planMaxText {
			step = string(r[:planMaxText])
		}
		status, _ := it.Get("status").(string)
		mark, ok := planMarks[status]
		if !ok {
			return "", fmt.Errorf("plan_update: items[%d].status must be pending / in_progress / done / skipped", i)
		}
		switch status {
		case "done", "skipped":
			done++
		case "in_progress":
			active++
		}
		lines = append(lines, fmt.Sprintf("%s %d. %s", mark, i+1, step))
	}
	fmt.Fprintf(&b, "计划已更新（%d/%d 完成）：\n%s", done, len(lines), strings.Join(lines, "\n"))
	if note, _ := o.Get("note").(string); strings.TrimSpace(note) != "" {
		b.WriteString("\n备注：" + strings.TrimSpace(note))
	}
	switch {
	case done == len(lines):
		b.WriteString("\n全部完成：核对结果后向用户汇报。")
	case active > 1:
		b.WriteString("\n同时只应有一项 in_progress：先做完当前这一步。")
	default:
		b.WriteString("\n按计划继续，全部完成前不要收尾。")
	}
	return b.String(), nil
}
