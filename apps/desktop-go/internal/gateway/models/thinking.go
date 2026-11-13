package models

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/intent"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ReasoningEffortHeader 是 Nomi 对话带给本机网关的思考深度。
// 网关按模型能力写成上游认识的参数；不支持的模型不转发这个头。
const ReasoningEffortHeader = "x-nomi-reasoning-effort"

// 档位由浅到深。off 只在模型能关掉思考时出现；on 只用于开关模型。
var levelRank = map[string]int{
	"off": 0, "none": 0, "on": 1,
	"minimal": 2, "low": 3, "medium": 4, "high": 5, "xhigh": 6, "max": 7, "ultra": 8,
}

// Profile 是一个模型在界面上可调的思考深度。Levels 为空表示不支持，选择器隐藏、请求不带参数。
// Default 是 Levels 的第二档（只有一档时用那一档）。
type Profile struct {
	Control     string
	ToggleStyle string
	Levels      []string
	Default     string
}

// Obj 给网关状态用。没有可调档位时返回 nil。
func (p Profile) Obj() *u.Obj {
	if len(p.Levels) < 2 {
		return nil
	}
	lv := make([]any, len(p.Levels))
	for i, s := range p.Levels {
		lv[i] = s
	}
	return u.NewObj("control", p.Control, "levels", lv, "default", p.Default)
}

// ProfileOf 按模型族 + 目录 + 用户覆盖得到思考深度。
// stored 是网关里的模型对象（可为 nil）：reasoning=false 表示用户标成不思考；
// efforts 非空时按这些档位、用 OpenAI 兼容的 reasoning_effort。
func ProfileOf(modelID string, stored *u.Obj) Profile {
	if stored != nil {
		if b, ok := stored.Get("reasoning").(bool); ok && !b {
			return Profile{}
		}
	}
	spec := reasoningSpec(modelID, stored)
	if spec == nil {
		return Profile{}
	}
	control, _ := spec.Get("control").(string)
	if control == "" || control == "none" {
		return Profile{}
	}
	p := Profile{Control: control}
	if s, ok := spec.Get("toggleStyle").(string); ok {
		p.ToggleStyle = s
	}
	p.Levels = levelsOf(spec)
	if len(p.Levels) < 2 {
		return Profile{}
	}
	p.Default = p.Levels[1]
	return p
}

// ResolveRequestLevel 把这一轮带来的档位收成该模型真正支持的一档。
// 空字符串表示调用方没选（后台任务等），不替它发明一档。
// 模型不支持、或档位不在列表里时：不支持则返回空（不发参数）；档位无效则落到默认的第二档。
func ResolveRequestLevel(modelID, requested string) string {
	p := ProfileOf(modelID, nil)
	if len(p.Levels) < 2 {
		return ""
	}
	requested = strings.ToLower(strings.TrimSpace(requested))
	if requested == "" {
		return ""
	}
	for _, l := range p.Levels {
		if l == requested {
			return l
		}
	}
	return p.Default
}

// GatewayRequestLevel 是 Nomi 对话发给本机网关的档位：只认得出的档位名就原样转交，
// 不在这里用目录（无用户覆盖）的能力否决。自定义模型的 like / efforts 只有网关拿得到，
// 由网关按真实模型对象收成可用的一档；reasoning=false、不支持思考的模型也在网关那边不转发。
// 空字符串（调用方没选）或认不出的值返回空，不发头。
func GatewayRequestLevel(requested string) string {
	requested = strings.ToLower(strings.TrimSpace(requested))
	if _, ok := levelRank[requested]; !ok {
		return ""
	}
	if requested == "none" {
		return "off"
	}
	return requested
}

// CallReasoning 是直接打到 Anthropic / Responses 时 CallOptions.Reasoning 的值。
// Chat Completions 走 DirectOptions，这里返回空，避免兼容层再写一份 reasoning_effort。
func CallReasoning(protocol, level string) string {
	switch protocol {
	case "anthropic", "openai-responses":
		switch level {
		case "off":
			return "none"
		case "on":
			return "medium"
		default:
			return level
		}
	default:
		return ""
	}
}

// DirectOptions 是不经本机网关、直接打上游时的厂商参数。
// 只写该模型支持的形状；不支持则返回 nil（请求里不出现推理字段）。
func DirectOptions(protocol, providerID, modelID, level string) *u.Obj {
	if protocol != "openai-chat" || level == "" || providerID == "" {
		return nil
	}
	p := ProfileOf(modelID, nil)
	if len(p.Levels) < 2 || !containsStr(p.Levels, level) {
		return nil
	}
	inner := u.NewObj()
	switch p.Control {
	case "toggle":
		on := level != "off"
		if p.ToggleStyle == "enable-thinking" {
			inner.Set("enable_thinking", on)
		} else {
			t := "disabled"
			if on {
				t = "enabled"
			}
			inner.Set("thinking", u.NewObj("type", t))
		}
	case "budget":
		if level == "off" {
			inner.Set("enable_thinking", false)
		} else {
			inner.Set("enable_thinking", true)
			inner.Set("thinking_budget", intent.EffortToBudget(budgetEffort(level), 0))
		}
	default:
		effort := level
		if effort == "off" {
			effort = "none"
		}
		if effort == "on" {
			effort = "medium"
		}
		inner.Set("reasoningEffort", effort)
	}
	return u.NewObj(providerID, inner)
}

func budgetEffort(level string) string {
	if level == "on" || level == "off" {
		return "medium"
	}
	return level
}

func reasoningSpec(modelID string, stored *u.Obj) *u.Obj {
	lookup := modelID
	if stored != nil {
		if lk, ok := stored.Get("like").(string); ok && strings.TrimSpace(lk) != "" {
			lookup = strings.TrimSpace(lk)
		}
	}
	id := BareModelID(lookup)
	var spec *u.Obj
	if fam := FamilyOf(id); fam != nil {
		if r, ok := fam.Get("reasoning").(*u.Obj); ok && r != nil {
			spec = r.Clone()
		}
	}
	if cat := CatalogEntry(id); cat != nil {
		if r, ok := cat.Get("reasoning").(*u.Obj); ok && r != nil {
			if spec == nil {
				spec = r.Clone()
			} else {
				spec = spec.Assign(r.Clone())
			}
		}
	}
	if stored == nil {
		return spec
	}
	efforts := strList(stored.Get("efforts"))
	if len(efforts) == 0 {
		return spec
	}
	if spec == nil {
		spec = u.NewObj()
	} else {
		spec = spec.Clone()
	}
	if spec.Get("control") == nil || spec.Get("control") == "" || spec.Get("control") == "none" {
		spec.Set("control", "effort")
	}
	anyEff := make([]any, len(efforts))
	for i, e := range efforts {
		anyEff[i] = e
	}
	spec.Set("efforts", anyEff)
	return spec
}

func levelsOf(spec *u.Obj) []string {
	control, _ := spec.Get("control").(string)
	canDisable := spec.Get("canDisable") == true
	efforts := strList(spec.Get("efforts"))
	hasNone := false
	var cleaned []string
	for _, e := range efforts {
		if e == "none" || e == "off" {
			hasNone = true
			continue
		}
		if e == "on" || e == "" {
			continue
		}
		cleaned = append(cleaned, e)
	}
	sortLevels(cleaned)
	switch control {
	case "toggle":
		if !canDisable {
			return nil
		}
		return []string{"off", "on"}
	case "budget":
		base := []string{"low", "medium", "high"}
		if canDisable {
			return append([]string{"off"}, base...)
		}
		return base
	case "effort", "adaptive", "level":
		if len(cleaned) == 0 {
			cleaned = []string{"low", "medium", "high"}
		}
		if canDisable || hasNone {
			return append([]string{"off"}, cleaned...)
		}
		return cleaned
	default:
		return nil
	}
}

func sortLevels(xs []string) {
	for i := 1; i < len(xs); i++ {
		j := i
		for j > 0 && levelRank[xs[j]] < levelRank[xs[j-1]] {
			xs[j], xs[j-1] = xs[j-1], xs[j]
			j--
		}
	}
}

func strList(v any) []string {
	arr, _ := v.([]any)
	if arr == nil {
		if ss, ok := v.([]string); ok {
			out := make([]string, 0, len(ss))
			for _, s := range ss {
				s = strings.ToLower(strings.TrimSpace(s))
				if s != "" {
					out = append(out, s)
				}
			}
			return out
		}
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		s, ok := x.(string)
		if !ok {
			continue
		}
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func containsStr(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
