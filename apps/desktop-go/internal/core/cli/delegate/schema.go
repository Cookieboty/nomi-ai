package delegate

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 工具入参：Node 用 zod（z.object），AI SDK 交给模型的是 asSchema(zod).jsonSchema（draft-07）。
// Go 侧直接声明同一份 JSON Schema（golden 比对逐字一致），并按同样约束校验（D-B7-S2-1）。
const (
	delegateInputSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"goal":{"type":"string","minLength":1,"maxLength":4000,"description":"要做成什么，写具体"},"done_when":{"type":"string","minLength":1,"maxLength":2000,"description":"完成标准：怎样算做完（如「npm test 通过」）"},"context":{"description":"已知背景：相关文件、报错、用户原话","type":"string","maxLength":8000},"out_of_scope":{"description":"不要碰的范围","type":"string","maxLength":2000},"kind":{"description":"任务类型：coding 编程开发 / prd 需求文档 / review 代码审查 / research 调研分析","type":"string","enum":["coding","prd","review","research"]},"cli":{"description":"只有用户在消息里点名了某个编程助手时才填（claude / codex / grok / gemini / dsh）","type":"string"},"cwd":{"description":"工作目录（必须是用户已授权的文件夹）；缺省用最近的工作目录","type":"string"},"background":{"description":"是否后台执行：默认 true（立刻返回 taskId，Nomi 可继续聊，完成后通知；用 delegate_status 查询）；false 则同步等到这一轮结束","type":"boolean"},"profile":{"description":"委派模型档位 id（如 default / cheap / local，或用户自定义）。缺省用设置里的默认档位；显式 model 优先于档位","type":"string"},"model":{"description":"覆盖子编程助手模型：第三方为「供应商/模型」，官方为 CLI 原生模型名。优先于 profile","type":"string"},"reasoning_effort":{"description":"覆盖思考深度（如 low / medium / high）；缺省用档位或 CLI 默认","type":"string"}},"required":["goal","done_when"],"additionalProperties":false}`
	statusInputSchema   = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"taskId":{"type":"string","minLength":1,"description":"delegate_to_cli 返回的 taskId（编程助手标签 id）"}},"required":["taskId"],"additionalProperties":false}`
	followupInputSchema = `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"taskId":{"type":"string","minLength":1,"description":"delegate_to_cli 返回的 taskId"},"message":{"type":"string","minLength":1,"maxLength":8000,"description":"在同一个编程助手标签里接着问的内容"}},"required":["taskId","message"],"additionalProperties":false}`
)

func mustSchema(s string) *util.Obj {
	v, err := util.ParseString(s)
	if err != nil {
		panic(err)
	}
	return v.(*util.Obj)
}

// zodError：z.object(...).parse 失败（Node 抛 ZodError；消息文本见 D-B7-S2-1）
type zodError struct{ msg string }

func (e *zodError) Error() string { return e.msg }

// parseInput：按 schema 校验 raw（z.object 语义：未知键丢弃，undefined 可选），返回只含已知键的对象。
func parseInput(schema *util.Obj, raw any) (*util.Obj, error) {
	o, ok := raw.(*util.Obj)
	if !ok || o == nil {
		return nil, &zodError{"expected object"}
	}
	props := schema.Get("properties").(*util.Obj)
	req := map[string]bool{}
	for _, r := range toList(schema.Get("required")) {
		req[util.Str(r)] = true
	}
	out := util.NewObj()
	for _, k := range props.Keys() {
		p := props.Get(k).(*util.Obj)
		v, has := o.Lookup(k)
		if !has || v == util.Undefined {
			if req[k] {
				return nil, &zodError{k + ": required"}
			}
			continue
		}
		switch p.Get("type") {
		case "string":
			s, ok := v.(string)
			if !ok {
				return nil, &zodError{k + ": expected string"}
			}
			n := util.UTF16Len(s)
			if mn, ok := p.Get("minLength").(float64); ok && float64(n) < mn {
				return nil, &zodError{k + ": too small"}
			}
			if mx, ok := p.Get("maxLength").(float64); ok && float64(n) > mx {
				return nil, &zodError{k + ": too big"}
			}
			if en := toList(p.Get("enum")); en != nil {
				found := false
				for _, e := range en {
					if e == s {
						found = true
					}
				}
				if !found {
					return nil, &zodError{k + ": invalid option"}
				}
			}
		case "boolean":
			if _, ok := v.(bool); !ok {
				return nil, &zodError{k + ": expected boolean"}
			}
		}
		out.Set(k, v)
	}
	return out, nil
}
