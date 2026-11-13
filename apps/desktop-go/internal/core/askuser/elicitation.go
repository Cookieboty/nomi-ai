package askuser

import (
	"math"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 表单字段。kind：text / choice / multi / bool / number / integer。
// values 与选项一一对应（choice、multi 提交 const / enum；标签可能是 title）。
type formField struct {
	name   string
	kind   string
	values []string
}

// ElicitationForm：ACP elicitation/create 与 Codex mcpServer/elicitation/request 的表单。
// 只收 form / openai/form。URL、工具审批和画不出来的必填项不进卡片。
type ElicitationForm struct {
	Questions []Question
	fields    []formField
}

// ElicitationIsApproval：Codex 把 MCP 工具审批也包成 elicitation（meta.codex_approval_kind）。
// 那是允许 / 拒绝，不是这张问题卡。
func ElicitationIsApproval(params *util.Obj) bool {
	_, _, ok := elicitationMeta(params)
	return ok
}

func elicitationMeta(params *util.Obj) (body *util.Obj, mode string, approval bool) {
	body = elicitationBody(params)
	if body == nil {
		return nil, "", false
	}
	mode = strings.TrimSpace(util.Str(body.Get("mode")))
	var meta *util.Obj
	if m, ok := body.Get("_meta").(*util.Obj); ok && m != nil {
		meta = m
	} else if m, ok := body.Get("meta").(*util.Obj); ok && m != nil {
		meta = m
	}
	if meta != nil && meta.Get("codex_approval_kind") == "mcp_tool_call" {
		return body, mode, true
	}
	return body, mode, false
}

// elicitationBody：ACP 的字段在 params 上；Codex 套在 params.request 里。
func elicitationBody(params *util.Obj) *util.Obj {
	if params == nil {
		return nil
	}
	if req, ok := params.Get("request").(*util.Obj); ok && req != nil &&
		(req.Has("mode") || req.Has("requestedSchema") || req.Has("message")) {
		return req
	}
	return params
}

const (
	fieldOK = iota
	fieldSkip
	fieldBad
)

// QuestionsFromElicitation：把表单 schema 收成问题卡能画的题。
// 必填项有认不出的类型、或必填项放不进四题时 ok 为 false（调用方回 cancel，不当作用户拒绝）。
func QuestionsFromElicitation(params *util.Obj) (ElicitationForm, bool) {
	body, mode, approval := elicitationMeta(params)
	if body == nil || approval {
		return ElicitationForm{}, false
	}
	if mode != "form" && mode != "openai/form" {
		return ElicitationForm{}, false
	}
	schema, ok := body.Get("requestedSchema").(*util.Obj)
	if !ok || schema == nil {
		return ElicitationForm{}, false
	}
	props, ok := schema.Get("properties").(*util.Obj)
	if !ok || props == nil || len(props.Keys()) == 0 {
		return ElicitationForm{}, false
	}
	required := map[string]bool{}
	if raw, ok := schema.Get("required").([]any); ok {
		for _, x := range raw {
			if s, ok := x.(string); ok && s != "" {
				required[s] = true
			}
		}
	}
	message := strings.TrimSpace(util.Str(body.Get("message")))
	type built struct {
		field formField
		q     Question
		need  bool
	}
	var rows []built
	for _, name := range props.Keys() {
		prop, isObj := props.Get(name).(*util.Obj)
		if !isObj || prop == nil {
			if required[name] {
				return ElicitationForm{}, false
			}
			continue
		}
		field, q, status := fieldFromProperty(name, prop)
		switch status {
		case fieldSkip:
			if required[name] {
				return ElicitationForm{}, false
			}
		case fieldBad:
			return ElicitationForm{}, false
		default:
			rows = append(rows, built{field: field, q: q, need: required[name]})
		}
	}
	var form ElicitationForm
	for _, row := range rows {
		if !row.need {
			continue
		}
		form.fields = append(form.fields, row.field)
		form.Questions = append(form.Questions, row.q)
	}
	for _, row := range rows {
		if row.need || len(form.Questions) >= maxQuestions {
			continue
		}
		form.fields = append(form.fields, row.field)
		form.Questions = append(form.Questions, row.q)
	}
	if len(form.Questions) == 0 || len(form.Questions) > maxQuestions {
		return ElicitationForm{}, false
	}
	for _, row := range rows {
		if row.need && !formHas(form, row.field.name) {
			return ElicitationForm{}, false
		}
	}
	for i := range form.Questions {
		form.Questions[i].ID = "q" + itoa(i+1)
		form.Questions[i].Prompt = elicitationPrompt(form.Questions[i], message, i == 0)
	}
	return form, true
}

func formHas(form ElicitationForm, name string) bool {
	for _, f := range form.fields {
		if f.name == name {
			return true
		}
	}
	return false
}

func elicitationPrompt(q Question, message string, first bool) string {
	prompt := q.Prompt
	if first && message != "" {
		if prompt == "" {
			prompt = message
		} else if message != prompt {
			prompt = message + "\n" + prompt
		}
	}
	prompt = clip(strings.TrimSpace(prompt), maxPrompt)
	if prompt == "" {
		prompt = "…"
	}
	return prompt
}

func fieldFromProperty(name string, prop *util.Obj) (formField, Question, int) {
	if prop.Has("enum") && prop.Has("oneOf") {
		return formField{}, Question{}, fieldBad
	}
	title := clip(strings.TrimSpace(util.Str(prop.Get("title"))), maxHeader)
	desc := strings.TrimSpace(util.Str(prop.Get("description")))
	prompt := desc
	if prompt == "" {
		prompt = title
	}
	if prompt == "" {
		prompt = name
	}
	header := ""
	if title != "" && title != prompt {
		header = title
	}
	q := Question{Prompt: prompt, Header: header, Options: []Option{}}
	field := formField{name: name}
	typ := util.Str(prop.Get("type"))
	switch typ {
	case "boolean":
		field.kind = "bool"
		q.Options = []Option{{ID: "a", Label: "Yes"}, {ID: "b", Label: "No"}}
	case "number", "integer":
		field.kind = typ
	case "array":
		values, opts, status := arrayChoices(prop.Get("items"))
		if status != fieldOK {
			return formField{}, Question{}, status
		}
		if len(opts) == 0 {
			return formField{}, Question{}, fieldSkip
		}
		field.kind = "multi"
		field.values = values
		q.Multi = true
		q.Options = opts
	case "string", "":
		if prop.Has("enum") || prop.Has("oneOf") {
			values, opts, status := stringChoices(prop)
			if status != fieldOK {
				return formField{}, Question{}, status
			}
			if len(opts) == 0 {
				if typ == "" {
					return formField{}, Question{}, fieldSkip
				}
				field.kind = "text"
				break
			}
			field.kind = "choice"
			field.values = values
			q.Options = opts
			break
		}
		if typ == "" {
			return formField{}, Question{}, fieldSkip
		}
		field.kind = "text"
	default:
		return formField{}, Question{}, fieldSkip
	}
	return field, q, fieldOK
}

func stringChoices(prop *util.Obj) (values []string, opts []Option, status int) {
	if raw, ok := prop.Get("enum").([]any); ok {
		for _, x := range raw {
			s, ok := x.(string)
			if !ok || strings.TrimSpace(s) == "" {
				continue
			}
			if len(values) >= maxOptions {
				break
			}
			// 协议值原样保留（含首尾空白、超长），只裁剪显示标签，答复才属于原 enum
			values = append(values, s)
			opts = append(opts, Option{ID: letter(len(opts)), Label: clip(strings.TrimSpace(s), maxLabel)})
		}
		return values, opts, fieldOK
	}
	raw, ok := prop.Get("oneOf").([]any)
	if !ok {
		return nil, nil, fieldSkip
	}
	return constChoices(raw)
}

func arrayChoices(items any) (values []string, opts []Option, status int) {
	o, ok := items.(*util.Obj)
	if !ok || o == nil {
		return nil, nil, fieldSkip
	}
	if o.Has("enum") && (o.Has("anyOf") || o.Has("oneOf")) {
		return nil, nil, fieldBad
	}
	if raw, ok := o.Get("enum").([]any); ok {
		for _, x := range raw {
			s, ok := x.(string)
			if !ok || strings.TrimSpace(s) == "" {
				continue
			}
			if len(values) >= maxOptions {
				break
			}
			// 协议值原样保留（含首尾空白、超长），只裁剪显示标签，答复才属于原 enum
			values = append(values, s)
			opts = append(opts, Option{ID: letter(len(opts)), Label: clip(strings.TrimSpace(s), maxLabel)})
		}
		return values, opts, fieldOK
	}
	raw, _ := o.Get("anyOf").([]any)
	if raw == nil {
		raw, _ = o.Get("oneOf").([]any)
	}
	if raw == nil {
		return nil, nil, fieldSkip
	}
	return constChoices(raw)
}

func constChoices(raw []any) (values []string, opts []Option, status int) {
	for _, x := range raw {
		o, isObj := x.(*util.Obj)
		if !isObj || o == nil {
			continue
		}
		s, ok := o.Get("const").(string)
		if !ok || strings.TrimSpace(s) == "" {
			continue
		}
		if len(values) >= maxOptions {
			break
		}
		label := clip(strings.TrimSpace(util.Str(o.Get("title"))), maxLabel)
		if label == "" {
			label = clip(strings.TrimSpace(s), maxLabel)
		}
		values = append(values, s)
		opts = append(opts, Option{
			ID:          letter(len(opts)),
			Label:       label,
			Description: clip(strings.TrimSpace(util.Str(o.Get("description"))), maxDesc),
		})
	}
	return values, opts, fieldOK
}

// ElicitationResult：写回 elicitation 的结果。
// 回答是 {action:accept, content:{字段:值}}，没答的字段省掉（不是 null）。
// 跳过是 decline；取消和超时都是 cancel（协议里没有超时，超时等于没选就关了）。
func ElicitationResult(in ElicitationForm, res Result) *util.Obj {
	switch res.Action {
	case ActionSkip:
		return util.NewObj("action", "decline", "content", nil)
	case ActionCancel, ActionTimeout:
		return util.NewObj("action", "cancel", "content", nil)
	}
	content := util.NewObj()
	details := strings.TrimSpace(res.Details)
	noted := false
	for i, f := range in.fields {
		if i >= len(in.Questions) {
			break
		}
		v, ok := fieldValue(f, in.Questions[i], answerOf(res.Answers, in.Questions[i].ID))
		if !ok {
			continue
		}
		// 补充说明只能附在自由文本上；选项值要能对上 schema，不能把说明拼进去
		if !noted && details != "" && f.kind == "text" {
			if s, isStr := v.(string); isStr {
				v = s + "\n补充：" + details
				noted = true
			}
		}
		content.Set(f.name, v)
	}
	return util.NewObj("action", "accept", "content", content)
}

func fieldValue(f formField, q Question, a Answer) (any, bool) {
	custom := strings.TrimSpace(a.Custom)
	switch f.kind {
	case "bool":
		if custom != "" {
			if b, ok := parseBool(custom); ok {
				return b, true
			}
		}
		switch {
		case len(a.Selected) > 0 && a.Selected[0] == "a":
			return true, true
		case len(a.Selected) > 0 && a.Selected[0] == "b":
			return false, true
		}
		return nil, false
	case "number", "integer":
		return parseNum(custom, f.kind == "integer")
	case "choice":
		if custom != "" {
			return custom, true
		}
		if v, ok := chosenValue(f.values, q, a.Selected); ok {
			return v, true
		}
		return nil, false
	case "multi":
		var arr []any
		seen := map[string]bool{}
		for _, id := range a.Selected {
			v, ok := valueFor(f.values, q, id)
			if !ok || seen[v] {
				continue
			}
			seen[v] = true
			arr = append(arr, v)
		}
		if custom != "" && !seen[custom] {
			arr = append(arr, custom)
		}
		if len(arr) == 0 {
			return nil, false
		}
		return arr, true
	default:
		if custom == "" {
			return nil, false
		}
		return custom, true
	}
}

func chosenValue(values []string, q Question, ids []string) (string, bool) {
	if len(ids) == 0 {
		return "", false
	}
	return valueFor(values, q, ids[0])
}

func valueFor(values []string, q Question, id string) (string, bool) {
	for i, opt := range q.Options {
		if opt.ID != id || i >= len(values) {
			continue
		}
		return values[i], true
	}
	return "", false
}

func parseBool(s string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "yes", "1":
		return true, true
	case "false", "no", "0":
		return false, true
	}
	return false, false
}

func parseNum(s string, integer bool) (any, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	if integer {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return nil, false
		}
		return float64(n), true
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil, false
	}
	return f, true
}
