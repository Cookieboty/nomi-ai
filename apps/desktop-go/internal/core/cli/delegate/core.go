// Package delegate：packages/core/src/cli/delegate（core.ts / worktree.ts / DelegateService.ts）的 1:1 移植。
// Nomi 委派编程助手：选谁、子任务档位、任务说明、汇报解析、worktree 隔离与 DelegateService。
//
// 数据形状与 Node 一致：档位 / 设置 / 结果都是有序 *util.Obj（键顺序 = Node 对象字面量顺序），
// 落盘与工具结果直接序列化，golden（testdata/b7s2-delegate.json）逐字比对。
package delegate

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DelegateClis：可以委派的内置编程助手（外部 CLI 暂不支持委派）
var DelegateClis = []string{"claude", "codex", "grok", "gemini", "dsh"}

// DelegateKinds：任务类型（设置里按类型配默认编程助手，§4.7）
var DelegateKinds = []string{"coding", "prd", "review", "research"}

// BuiltinAgentProfiles：内置档位（每次返回新对象，等同 Node 的 { ...p } 拷贝）
func BuiltinAgentProfiles() []*util.Obj {
	return []*util.Obj{
		util.NewObj("id", "default", "label", "默认（沿用 CLI）"),
		util.NewObj("id", "cheap", "label", "便宜模型"),
		util.NewObj("id", "local", "label", "本地优先", "preferLocal", true),
	}
}

// DefaultDelegateSettings：{ enabled: true, defaults: {}, defaultProfileId: 'default' }
func DefaultDelegateSettings() *util.Obj {
	return util.NewObj("enabled", true, "defaults", util.NewObj(), "defaultProfileId", "default")
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func IsDelegateCli(v any) bool  { s, ok := v.(string); return ok && contains(DelegateClis, s) }
func IsDelegateKind(v any) bool { s, ok := v.(string); return ok && contains(DelegateKinds, s) }

var profileIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

func trim(s string) string { return util.JSTrim(s) }
func slice(s string, n int) string {
	return util.UTF16Slice0(s, n)
}

func strField(r *util.Obj, k string) (string, bool) {
	s, ok := r.Get(k).(string)
	return s, ok
}

func sanitizeProfile(raw any) *util.Obj {
	r, ok := raw.(*util.Obj)
	if !ok || r == nil {
		return nil
	}
	id := ""
	if s, ok := strField(r, "id"); ok {
		id = slice(trim(s), 64)
	}
	if id == "" || !profileIDRe.MatchString(id) {
		return nil
	}
	label := id
	if s, ok := strField(r, "label"); ok && trim(s) != "" {
		label = slice(trim(s), 80)
	}
	model := ""
	if s, ok := strField(r, "model"); ok && trim(s) != "" {
		model = slice(trim(s), 128)
	}
	out := util.NewObj("id", id, "label", label)
	if model != "" {
		out.Set("model", model)
	}
	if r.Has("reasoningEffort") && r.Get("reasoningEffort") == nil {
		out.Set("reasoningEffort", nil)
	} else if s, ok := strField(r, "reasoningEffort"); ok && trim(s) != "" {
		out.Set("reasoningEffort", slice(trim(s), 32))
	}
	if r.Get("preferLocal") == true {
		out.Set("preferLocal", true)
	}
	return out
}

func toList(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []*util.Obj:
		out := make([]any, len(a))
		for i, x := range a {
			out[i] = x
		}
		return out
	}
	return nil
}

// MergeAgentProfiles：内置 + 用户档位按 id 合并（用户可覆盖 label/model）。Map 语义：保持首次插入位置。
func MergeAgentProfiles(user any) []*util.Obj {
	var order []string
	m := map[string]*util.Obj{}
	for _, p := range BuiltinAgentProfiles() {
		order = append(order, util.Str(p.Get("id")))
		m[util.Str(p.Get("id"))] = p
	}
	for _, raw := range toList(user) {
		p := sanitizeProfile(raw)
		if p == nil {
			continue
		}
		id := util.Str(p.Get("id"))
		prev := m[id]
		label := util.Str(p.Get("label"))
		if label == "" && prev != nil {
			label = util.Str(prev.Get("label"))
		}
		if label == "" {
			label = id
		}
		n := util.NewObj("id", id, "label", label)
		if p.Has("model") {
			n.Set("model", p.Get("model"))
		} else if prev != nil && util.Str(prev.Get("model")) != "" {
			n.Set("model", prev.Get("model"))
		}
		if p.Has("reasoningEffort") {
			n.Set("reasoningEffort", p.Get("reasoningEffort"))
		} else if prev != nil && prev.Has("reasoningEffort") {
			n.Set("reasoningEffort", prev.Get("reasoningEffort"))
		}
		if p.Get("preferLocal") == true || (prev != nil && prev.Get("preferLocal") == true) {
			n.Set("preferLocal", true)
		}
		if _, ok := m[id]; !ok {
			order = append(order, id)
		}
		m[id] = n
	}
	out := make([]*util.Obj, 0, len(order))
	for _, id := range order {
		out = append(out, m[id])
	}
	return out
}

// SanitizeDelegateSettings：任意 JSON → DelegateSettings（有序对象）
func SanitizeDelegateSettings(raw any) *util.Obj {
	r, _ := raw.(*util.Obj)
	if r == nil {
		r = util.NewObj()
	}
	defaults := util.NewObj()
	if d, ok := r.Get("defaults").(*util.Obj); ok && d != nil {
		for _, k := range DelegateKinds {
			if v := d.Get(k); IsDelegateCli(v) {
				defaults.Set(k, v)
			}
		}
	}
	var profiles []*util.Obj
	isArr := false
	if a, ok := r.Get("profiles").([]any); ok {
		isArr = true
		profiles = []*util.Obj{}
		for _, x := range a {
			if p := sanitizeProfile(x); p != nil {
				profiles = append(profiles, p)
			}
		}
	}
	merged := MergeAgentProfiles(profiles)
	dpid := "default"
	if s, ok := strField(r, "defaultProfileId"); ok && trim(s) != "" {
		dpid = slice(trim(s), 64)
	}
	cheap := ""
	if s, ok := strField(r, "cheapModel"); ok && trim(s) != "" {
		cheap = slice(trim(s), 128)
	}
	found := false
	for _, p := range merged {
		if p.Get("id") == dpid {
			found = true
		}
	}
	if !found {
		dpid = "default"
	}
	out := util.NewObj("enabled", r.Get("enabled") != false, "defaults", defaults, "defaultProfileId", dpid)
	if isArr && len(profiles) > 0 {
		ps := make([]any, len(profiles))
		for i, p := range profiles {
			ps[i] = p
		}
		out.Set("profiles", ps)
	}
	if cheap != "" {
		out.Set("cheapModel", cheap)
	}
	return out
}

// OverridesInput：resolveDelegateOverrides 的入参；nil 指针 = undefined/null（Has* 区分 null）
type OverridesInput struct {
	Model           any // string | nil
	ReasoningEffort any // string | nil（undefined 与 null 同样视为未给）
	Profile         any
	Settings        *util.Obj
}

// ResolveDelegateOverrides：显式 model > profile.model >（cheap 时 settings.cheapModel）> 不覆盖。
// 返回 { ok:true, profileId, model?, reasoningEffort?, preferLocal? } 或 { ok:false, code, message }
func ResolveDelegateOverrides(in OverridesInput) *util.Obj {
	s := in.Settings
	profiles := MergeAgentProfiles(s.Get("profiles"))
	requested := ""
	if p, ok := in.Profile.(string); ok {
		requested = trim(p)
	}
	if requested == "" {
		requested = util.Str(s.Get("defaultProfileId"))
	}
	if requested == "" {
		requested = "default"
	}
	var profile *util.Obj
	for _, p := range profiles {
		if p.Get("id") == requested {
			profile = p
			break
		}
	}
	if profile == nil {
		return util.NewObj("ok", false, "code", "unknown_profile", "message", "未知的委派模型档位："+requested)
	}
	explicit := ""
	if m, ok := in.Model.(string); ok {
		explicit = trim(m)
	}
	model := ""
	if explicit != "" {
		model = slice(explicit, 128)
	} else if pm := util.Str(profile.Get("model")); trim(pm) != "" {
		model = trim(pm)
	} else if profile.Get("id") == "cheap" && trim(util.Str(s.Get("cheapModel"))) != "" {
		model = trim(util.Str(s.Get("cheapModel")))
	}
	var effort any
	hasEffort := false
	if in.ReasoningEffort != nil {
		e := trim(jsString(in.ReasoningEffort))
		hasEffort = true
		if e != "" {
			effort = slice(e, 32)
		}
	} else if profile.Has("reasoningEffort") {
		hasEffort = true
		effort = profile.Get("reasoningEffort")
	}
	out := util.NewObj("ok", true, "profileId", profile.Get("id"))
	if model != "" {
		out.Set("model", model)
	}
	if hasEffort {
		out.Set("reasoningEffort", effort)
	}
	if profile.Get("preferLocal") == true {
		out.Set("preferLocal", true)
	}
	return out
}

func jsString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return util.FormatNumber(x)
	case nil:
		return "null"
	}
	return util.Stringify(v)
}

var aliases = map[string]string{
	"claude": "claude", "claude-code": "claude", "claudecode": "claude", "cc": "claude",
	"codex": "codex", "grok": "grok", "gemini": "gemini", "dsh": "dsh",
}

var wsRun = util.JSRe(`\s+`)

// ResolveDelegateCli：名字 → 编程助手 id（不区分大小写，接受别名）；认不出返回 ""
func ResolveDelegateCli(name any) string {
	s, ok := name.(string)
	if !ok {
		return ""
	}
	return aliases[wsRun.ReplaceAllString(util.JSLower(trim(s)), "-")]
}

// Picked：pickDelegateCli 的结果
type Picked struct{ Cli, By string }

// PickInput：pickDelegateCli 入参；"" = null
type PickInput struct {
	Pinned, Requested, Kind string
	Defaults                *util.Obj
	Installed               []string
}

// PickDelegateCli：钉住 > 点名 > 类型默认 > coding 默认 > 已安装的第一个；都不可用返回 nil
func PickDelegateCli(i PickInput) *Picked {
	ok := func(c string) bool { return c != "" && contains(i.Installed, c) }
	if i.Pinned != "" {
		if ok(i.Pinned) {
			return &Picked{i.Pinned, "pinned"}
		}
		return nil
	}
	if ok(i.Requested) {
		return &Picked{i.Requested, "requested"}
	}
	d := i.Defaults
	if d == nil {
		d = util.NewObj()
	}
	if k, _ := d.Get(i.Kind).(string); ok(k) {
		return &Picked{k, "kind-default"}
	}
	if c, _ := d.Get("coding").(string); ok(c) {
		return &Picked{c, "coding-default"}
	}
	for _, c := range DelegateClis {
		if contains(i.Installed, c) {
			return &Picked{c, "auto"}
		}
	}
	return nil
}

var modeOrder = []string{"plan", "manual", "acceptEdits", "auto", "bypass"}

func indexOf(xs []string, v string) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}

// ChildPermissionMode：取更严的一个；永远不是 bypass
func ChildPermissionMode(nomi, tabDefault string) string {
	a, b := indexOf(modeOrder, nomi), indexOf(modeOrder, tabDefault)
	if a < 0 {
		a = 0
	}
	if b < 0 {
		b = 0
	}
	m := modeOrder[min(a, b)]
	if m == "bypass" {
		return "auto"
	}
	return m
}

// DelegateBrief：任务说明
type DelegateBrief struct{ Goal, Context, DoneWhen, OutOfScope string }

// BuildDelegatePrompt：发给编程助手的第一条消息（§4.4）
func BuildDelegatePrompt(b DelegateBrief) string {
	lines := []string{"你在帮 Nomi（用户的桌面助手）完成一项任务。", "目标：" + trim(b.Goal)}
	if trim(b.Context) != "" {
		lines = append(lines, "背景："+trim(b.Context))
	}
	lines = append(lines, "完成标准："+trim(b.DoneWhen))
	if trim(b.OutOfScope) != "" {
		lines = append(lines, "不要碰："+trim(b.OutOfScope))
	}
	lines = append(lines, "",
		"做完后，最后一条回复只按下面的格式输出（标记原样保留）：",
		"[nomi-report]",
		"做了什么：…",
		"改动的文件：每行一个相对路径",
		"没做完的：…（没有就写「无」）",
		"需要用户决定的：…（没有就写「无」）",
		"[/nomi-report]")
	return strings.Join(lines, "\n")
}

var reportKeys = []struct {
	k  string
	re *regexp.Regexp
}{
	{"done", regexp.MustCompile(`^做了什么[:：]`)},
	{"changedFiles", regexp.MustCompile(`^改动的文件[:：]`)},
	{"unfinished", regexp.MustCompile(`^没做完的[:：]`)},
	{"needsUser", regexp.MustCompile(`^需要用户决定的[:：]`)},
}

var noneRe = regexp.MustCompile(`(?i)^(无|没有|none|n/a|-)?[。.]?$`)
var reportBlockRe = regexp.MustCompile(`(?s)\[nomi-report\](.*?)\[/nomi-report\]`)
var crlfRe = regexp.MustCompile(`\r?\n`)
var bulletRe = util.JSRe(`^[-*•]\s*`)
var tickRe = regexp.MustCompile("^`|`$")

// ParseDelegateReport：解析最后一个 [nomi-report] 块；没有或缺「做了什么」时返回 nil。
// 结果：{ done, changedFiles, unfinished?, needsUser? }
func ParseDelegateReport(text string) *util.Obj {
	blocks := reportBlockRe.FindAllStringSubmatch(text, -1)
	if len(blocks) == 0 || blocks[len(blocks)-1][1] == "" {
		return nil
	}
	body := blocks[len(blocks)-1][1]
	parts := map[string][]string{}
	cur := ""
	for _, raw := range crlfRe.Split(body, -1) {
		line := trim(raw)
		hit := -1
		for i, rk := range reportKeys {
			if rk.re.MatchString(line) {
				hit = i
				break
			}
		}
		if hit >= 0 {
			cur = reportKeys[hit].k
			rest := trim(reportKeys[hit].re.ReplaceAllString(line, ""))
			if rest != "" {
				parts[cur] = []string{rest}
			} else {
				parts[cur] = []string{}
			}
		} else if cur != "" && line != "" {
			parts[cur] = append(parts[cur], line)
		}
	}
	join := func(k string) string {
		n := 600
		if k == "done" {
			n = 1500
		}
		return slice(trim(strings.Join(parts[k], "\n")), n)
	}
	done := join("done")
	if done == "" {
		return nil
	}
	files := []any{}
	for _, l := range parts["changedFiles"] {
		l = trim(tickRe.ReplaceAllString(bulletRe.ReplaceAllString(l, ""), ""))
		if l == "" || noneRe.MatchString(l) {
			continue
		}
		if len(files) >= 50 {
			break
		}
		files = append(files, slice(l, 200))
	}
	out := util.NewObj("done", done, "changedFiles", files)
	for _, k := range []string{"unfinished", "needsUser"} {
		if v := join(k); v != "" && !noneRe.MatchString(v) {
			out.Set(k, v)
		}
	}
	return out
}

var quoteEdgeRe = regexp.MustCompile(`^"|"$`)

// ParsePorcelain：git status --porcelain [-z] → 相对路径（重命名取新路径）
func ParsePorcelain(out string) []string {
	files := []string{}
	if out == "" {
		return files
	}
	if strings.Contains(out, "\x00") {
		var parts []string
		for _, s := range strings.Split(out, "\x00") {
			if s != "" {
				parts = append(parts, s)
			}
		}
		for i := 0; i < len(parts); i++ {
			ent := parts[i]
			if util.UTF16Len(ent) < 3 {
				continue
			}
			xy := ent[:2]
			file := jsSliceFrom(ent, 3)
			if (xy[0] == 'R' || xy[0] == 'C') && i+1 < len(parts) {
				i++
			}
			file = quoteEdgeRe.ReplaceAllString(file, "")
			if file != "" {
				files = append(files, file)
			}
		}
		return files
	}
	for _, line := range crlfRe.Split(out, -1) {
		if util.UTF16Len(line) < 4 {
			continue
		}
		p := jsSliceFrom(line, 3)
		if a := strings.Index(p, " -> "); a >= 0 {
			p = p[a+4:]
		}
		p = quoteEdgeRe.ReplaceAllString(p, "")
		if p != "" {
			files = append(files, p)
		}
	}
	return files
}

// jsSliceFrom：s.slice(n)（UTF-16 单位）
func jsSliceFrom(s string, n int) string {
	return s[len(util.UTF16Slice0(s, n)):]
}

// TailText：截断到 max 字符，保留结尾
func TailText(text string, max int) string {
	s := trim(text)
	if util.UTF16Len(s) <= max {
		return s
	}
	return "…" + util.UTF16Tail(s, max)
}
