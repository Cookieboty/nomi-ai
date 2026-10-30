// Package agents ports apps/desktop-electron/internal/core/src/agents。
//
// parsers.go 1:1 移植 agents/parsers.ts：解析各编程助手本地会话文件，推断会话身份
// （id / cwd / 标题）与最后状态。字符串字段 "" 即 TS 的 undefined（str() 永不产出空串）。
package agents

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// AgentKind mirrors AgentKind。
type AgentKind = string

// AgentStatus mirrors AgentStatus。
type AgentStatus = string

// LastPhase mirrors LastPhase。
type LastPhase = string

// SessionInfo mirrors SessionInfo（"" = undefined；LastAt nil = undefined）。
type SessionInfo struct {
	SessionID, ParentID, Cwd, Model, ReasoningEffort, Title string
	// PermissionMode 可为已定义的空串（codex sandbox_policy: ""），故用指针：nil = undefined。
	PermissionMode *string
	Phase          LastPhase
	Detail         string
	LastAt         *float64
}

func sp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// orp = a ?? b（a 为 "" 视为 undefined）。
func orp(prev *string, vs ...string) *string {
	if v := or(vs...); v != "" {
		return &v
	}
	return prev
}

// TypeError mirrors a JS TypeError thrown by property access on null.
type TypeError struct{ Msg string }

func (e *TypeError) Error() string { return e.Msg }

// Name reports the JS error name.
func (e *TypeError) Name() string { return "TypeError" }

// JsonlEvents mirrors jsonlEvents。
func JsonlEvents(text string, limit int) []*util.Obj {
	text = strings.TrimPrefix(text, "\uFEFF")
	lines := []string{}
	for _, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(util.JSTrim(l), "{") {
			lines = append(lines, l)
		}
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	out := []*util.Obj{}
	for _, line := range lines {
		v, err := util.ParseString(line)
		if err != nil {
			continue
		}
		switch x := v.(type) {
		case *util.Obj:
			out = append(out, x)
		case []any:
			out = append(out, util.NewObj()) // 数组也是 object：属性读取皆 undefined
		}
	}
	return out
}

func str(v any) string { s, _ := sh.NStr(v); return s }

func or(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

func get(v any, k string) any {
	if o, ok := v.(*util.Obj); ok && o != nil {
		return o.Get(k)
	}
	return nil
}

var (
	reWsUnd = regexp.MustCompile(`[_` + strings.Trim(util.JSWhitespace, "[]") + `]+`)
	reUnd   = regexp.MustCompile(`_`)
	reBegin = regexp.MustCompile(`_begin$`)
	reIntr  = regexp.MustCompile(`(?i)\[Request interrupted by user`)
)

func codexPermissionMode(p *util.Obj) *string {
	if x := or(str(p.Get("permission_mode")), str(p.Get("permissionMode"))); x != "" {
		return &x
	}
	raw := sh.Nullish(p.Get("sandbox_policy"), p.Get("sandboxPolicy"), p.Get("sandbox_mode"))
	var sandbox *string
	switch x := raw.(type) {
	case string:
		sandbox = &x // '' 不是 nullish：原样返回
	case *util.Obj:
		sandbox = sp(str(sh.Nullish(x.Get("type"), x.Get("mode"))))
	}
	approval := or(str(p.Get("approval_policy")), str(p.Get("approvalPolicy")))
	if sandbox != nil {
		sb := reWsUnd.ReplaceAllString(util.JSLower(*sandbox), "-")
		switch sb {
		case "danger-full-access", "dangerfullaccess":
			return sp("bypass")
		case "read-only", "readonly":
			return sp("manual")
		case "workspace-write", "workspacewrite":
			if reUnd.ReplaceAllString(util.JSLower(approval), "-") == "on-request" {
				return sp("auto")
			}
			return sp("acceptEdits")
		}
		return sandbox
	}
	return sp(approval)
}

func ts(v any) *float64 {
	switch x := v.(type) {
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			if x <= 1e12 {
				x *= 1000
			}
			return &x
		}
	case string:
		if n, ok := reminders.DateParse(x); ok {
			return &n
		}
	}
	return nil
}

// contentText mirrors contentText（数组元素为 null 时 JS 读 .type 抛 TypeError）。
func contentText(content any) (string, bool) {
	switch x := content.(type) {
	case string:
		return x, true
	case []any:
		for _, c := range x {
			if c == nil {
				panic(&TypeError{"Cannot read properties of null (reading 'type')"})
			}
			o := sh.AsJ(c)
			if t := o.Get("type"); t == "text" || t == "input_text" {
				if s, ok := o.Get("text").(string); ok {
					return s, true
				}
			}
		}
	}
	return "", false
}

func ctext(content any) string { s, _ := contentText(content); return s }

func hasType(content any, typ string) bool {
	arr, ok := content.([]any)
	if !ok {
		return false
	}
	for _, c := range arr {
		if get(c, "type") == typ {
			return true
		}
	}
	return false
}

func toolName(content any) string {
	arr, ok := content.([]any)
	if !ok {
		return ""
	}
	for _, c := range arr {
		o := sh.AsJ(c)
		if o.Get("type") == "tool_use" {
			if s, ok := o.Get("name").(string); ok {
				return s
			}
		}
	}
	return ""
}

func title(raw string, max ...int) string {
	m := 80
	if len(max) > 0 {
		m = max[0]
	}
	if p := sh.CleanTitle(raw, m); p != nil {
		return *p
	}
	return ""
}

func claudeMeta(info *SessionInfo, e *util.Obj) {
	if info.SessionID == "" {
		info.SessionID = str(e.Get("sessionId"))
	}
	if info.Cwd == "" {
		info.Cwd = str(e.Get("cwd"))
	}
	message := e.Get("message")
	info.Model = or(str(get(message, "model")), str(e.Get("model")), info.Model)
	info.ReasoningEffort = or(str(e.Get("effort")), str(e.Get("perTurnEffort")), str(get(message, "effort")), info.ReasoningEffort)
	info.PermissionMode = orp(info.PermissionMode, str(e.Get("permissionMode")), str(get(message, "permissionMode")))
}

// ParseClaudeSession mirrors parseClaudeSession。
func ParseClaudeSession(head, tail string) SessionInfo {
	info := SessionInfo{Phase: "unknown"}
	for _, e := range JsonlEvents(head, 200) {
		claudeMeta(&info, e)
		if e.Get("isSidechain") == true && info.ParentID == "" {
			info.ParentID = str(e.Get("sessionId"))
		}
		if info.Title == "" && e.Get("type") == "user" && e.Get("isMeta") != true && e.Get("isSidechain") != true {
			if msg := e.Get("message"); util.Truthy(msg) && !hasType(get(msg, "content"), "tool_result") {
				info.Title = title(ctext(get(msg, "content")))
			}
		}
		if info.Title == "" && e.Get("type") == "summary" {
			info.Title = title(str(e.Get("summary")))
		}
	}
	events := JsonlEvents(tail, 400)
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		t := util.JSString(sh.Nullish(e.Get("type"), ""))
		claudeMeta(&info, e)
		if t == "result" {
			err := e.Get("is_error") == true || strings.HasPrefix(util.JSString(sh.Nullish(e.Get("subtype"), "")), "error")
			info.Phase = "task-done"
			if err {
				info.Phase = "error"
			}
			info.Detail = or(str(e.Get("result")), str(e.Get("error")))
			info.LastAt = ts(e.Get("timestamp"))
			break
		}
		if t == "assistant" {
			msg := sh.Nullish(e.Get("message"), util.NewObj())
			stop := str(get(msg, "stop_reason"))
			tool := toolName(get(msg, "content"))
			info.LastAt = ts(e.Get("timestamp"))
			if e.Get("isApiErrorMessage") == true || get(msg, "model") == "<synthetic>" {
				info.Phase = "error"
				info.Detail = title(ctext(get(msg, "content")), 120)
			} else if tool != "" || stop == "tool_use" {
				info.Phase = "tool"
				info.Detail = tool
			} else if stop == "end_turn" || stop == "stop_sequence" || stop == "max_tokens" {
				info.Phase = "turn-done"
				info.Detail = title(ctext(get(msg, "content")), 120)
			} else {
				info.Phase = "working"
			}
			break
		}
		if t == "user" {
			msg := sh.Nullish(e.Get("message"), util.NewObj())
			info.LastAt = ts(e.Get("timestamp"))
			info.Phase = "working"
			if hasType(get(msg, "content"), "tool_result") {
				info.Detail = "tool_result"
			}
			if reIntr.MatchString(ctext(get(msg, "content"))) {
				info.Phase = "turn-done"
			}
			break
		}
		if t == "progress" || t == "tool_use" || t == "tool_result" {
			info.Phase = "tool"
			info.LastAt = ts(e.Get("timestamp"))
			break
		}
	}
	return info
}

func codexCtx(info *SessionInfo, p *util.Obj, cwdFirst bool) {
	if cwdFirst {
		if info.Cwd == "" {
			info.Cwd = str(p.Get("cwd"))
		}
		info.Model = or(str(p.Get("model")), info.Model)
	} else {
		info.Model = or(str(p.Get("model")), info.Model)
		if info.Cwd == "" {
			info.Cwd = str(p.Get("cwd"))
		}
	}
	info.ReasoningEffort = or(str(p.Get("reasoning_effort")), str(p.Get("effort")), info.ReasoningEffort)
	if pm := codexPermissionMode(p); pm != nil {
		info.PermissionMode = pm
	}
}

// ParseCodexSession mirrors parseCodexSession。
func ParseCodexSession(head, tail string) SessionInfo {
	info := SessionInfo{Phase: "unknown"}
	for _, e := range JsonlEvents(head, 200) {
		p := sh.AsJ(e.Get("payload"))
		typ := e.Get("type")
		if typ == "session_meta" {
			if info.SessionID == "" {
				info.SessionID = str(p.Get("id"))
			}
			codexCtx(&info, p, true)
		}
		if typ == "turn_context" {
			codexCtx(&info, p, false)
		}
		if !util.Truthy(typ) && str(e.Get("id")) != "" && info.SessionID == "" {
			info.SessionID = str(e.Get("id"))
		}
		if info.Title == "" && typ == "event_msg" && p.Get("type") == "user_message" {
			info.Title = title(str(p.Get("message")))
		}
		if info.Title == "" && typ == "response_item" && p.Get("type") == "message" && p.Get("role") == "user" {
			info.Title = title(ctext(p.Get("content")))
		}
		if typ == "thread.started" && info.SessionID == "" {
			info.SessionID = str(e.Get("thread_id"))
		}
	}
	events := JsonlEvents(tail, 400)
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		t := util.JSString(sh.Nullish(e.Get("type"), ""))
		p := sh.AsJ(e.Get("payload"))
		pt := util.JSString(sh.Nullish(p.Get("type"), ""))
		if t == "session_meta" || t == "turn_context" {
			codexCtx(&info, p, false)
		}
		at := ts(e.Get("timestamp"))
		if t == "event_msg" {
			switch {
			case pt == "task_complete":
				info.Phase, info.Detail, info.LastAt = "turn-done", title(str(p.Get("last_agent_message")), 120), at
			case pt == "error" || pt == "stream_error" || pt == "turn_aborted":
				info.Phase = "error"
				if pt == "turn_aborted" {
					info.Phase = "turn-done"
				}
				info.Detail, info.LastAt = or(str(p.Get("message")), str(p.Get("reason"))), at
			case pt == "exec_command_begin" || pt == "patch_apply_begin" || pt == "mcp_tool_call_begin":
				info.Phase, info.Detail, info.LastAt = "tool", reBegin.ReplaceAllString(pt, ""), at
			case pt == "task_started" || pt == "user_message" || pt == "agent_reasoning":
				info.Phase, info.LastAt = "working", at
			case pt == "agent_message":
				info.Phase, info.Detail, info.LastAt = "working", title(str(p.Get("message")), 120), at
			default:
				continue
			}
			break
		}
		if t == "response_item" {
			if pt == "function_call" || pt == "local_shell_call" || pt == "custom_tool_call" {
				info.Phase, info.Detail = "tool", or(str(p.Get("name")), pt)
			} else {
				info.Phase = "working"
			}
			info.LastAt = at
			break
		}
		if t == "turn.failed" || t == "error" {
			info.Phase = "error"
			info.Detail = or(str(e.Get("message")), str(get(e.Get("error"), "message")))
			break
		}
		if t == "turn.completed" {
			info.Phase, info.Detail = "turn-done", str(e.Get("message"))
			break
		}
		if t == "turn.started" || t == "item.started" || t == "item.completed" || t == "thread.started" {
			info.Phase = "working"
			if t == "item.started" {
				info.Phase = "tool"
			}
			break
		}
	}
	return info
}

// jsKeys mirrors Object.keys(v) for any truthy value.
func jsKeys(v any) []string {
	switch x := v.(type) {
	case *util.Obj:
		return x.Keys()
	case []any:
		ks := make([]string, len(x))
		for i := range x {
			ks[i] = strconv.Itoa(i)
		}
		return ks
	case string:
		n := util.UTF16Len(x)
		ks := make([]string, n)
		for i := 0; i < n; i++ {
			ks[i] = strconv.Itoa(i)
		}
		return ks
	}
	return nil
}

// ParseGrokSession mirrors parseGrokSession。
func ParseGrokSession(text, fallbackSessionID string) SessionInfo {
	info := SessionInfo{Phase: "unknown", SessionID: fallbackSessionID}
	for _, e := range JsonlEvents(text, 1000) {
		params := sh.Nullish(e.Get("params"), e)
		update := sh.Nullish(get(params, "update"), params)
		if info.SessionID == "" {
			info.SessionID = or(str(e.Get("sessionId")), str(get(params, "sessionId")), str(get(update, "sessionId")))
		}
		if info.Cwd == "" {
			info.Cwd = or(str(e.Get("cwd")), str(get(params, "cwd")), str(get(update, "cwd")))
		}
		usage := sh.Nullish(get(update, "usage"), get(params, "usage"), e.Get("usage"))
		modelUsage := get(usage, "modelUsage")
		model := ""
		if util.Truthy(modelUsage) {
			for _, k := range jsKeys(modelUsage) {
				if k != "" && k != "unknown" {
					model = k
					break
				}
			}
		}
		info.Model = or(model, str(get(usage, "model")), str(get(update, "model")), str(get(params, "model")), info.Model)
		info.ReasoningEffort = or(str(get(update, "reasoningEffort")), str(get(params, "reasoningEffort")), str(e.Get("reasoningEffort")), info.ReasoningEffort)
		info.PermissionMode = orp(info.PermissionMode, str(get(update, "currentModeId")), str(get(params, "currentModeId")), str(e.Get("currentModeId")))
		t := or(str(get(update, "prompt")), str(get(update, "userMessage")), str(get(params, "prompt")), str(e.Get("prompt")))
		if info.Title == "" {
			info.Title = title(t)
		}
		if at := ts(sh.Nullish(e.Get("timestamp"), e.Get("time"), get(update, "timestamp"))); at != nil && *at != 0 {
			info.LastAt = at
		}
		if str(get(update, "sessionUpdate")) == "turn_completed" {
			info.Phase = "turn-done"
		}
	}
	return info
}

// ParseGeminiSession mirrors parseGeminiSession。
func ParseGeminiSession(raw string) SessionInfo {
	info := SessionInfo{Phase: "unknown"}
	j := gemini.FoldChat(raw)
	info.SessionID = j.SessionID
	msgs := j.Messages
	var firstUser *util.Obj
	for _, m := range msgs {
		if m.Get("type") == "user" {
			firstUser = m
			break
		}
	}
	info.Title = or(title(j.Summary), title(gemini.Text(get(firstUser, "content"))))
	for _, m := range msgs {
		thinking := m.Get("thinkingConfig")
		info.Model = or(str(m.Get("model")), str(m.Get("modelName")), str(get(m.Get("metadata"), "model")), info.Model)
		info.ReasoningEffort = or(str(m.Get("reasoningEffort")), str(m.Get("reasoning_effort")), str(m.Get("effort")), str(m.Get("reasoning")),
			str(get(thinking, "effort")), str(get(thinking, "thinkingLevel")), str(get(thinking, "thinking_level")), info.ReasoningEffort)
		info.PermissionMode = orp(info.PermissionMode, str(m.Get("permissionMode")), str(m.Get("permission_mode")), str(m.Get("approvalMode")), str(m.Get("mode")))
	}
	var last *util.Obj
	if len(msgs) > 0 {
		last = msgs[len(msgs)-1]
	}
	info.LastAt = ts(get(last, "timestamp"))
	if info.LastAt == nil && j.LastUpdated != "" {
		info.LastAt = ts(j.LastUpdated)
	}
	if last == nil {
		return info
	}
	switch last.Get("type") {
	case "gemini", "model":
		calls, _ := last.Get("toolCalls").([]any)
		if len(calls) == 0 {
			info.Phase = "turn-done"
		} else {
			info.Phase = "working"
			for _, c := range calls {
				if c == nil {
					panic(&TypeError{"Cannot read properties of null (reading 'result')"})
				}
				co := sh.AsJ(c)
				if !co.Has("result") && co.Get("status") != "error" {
					info.Phase = "tool"
					break
				}
			}
		}
		info.Detail = title(gemini.Text(last.Get("content")), 120)
	case "error":
		info.Phase = "error"
	default:
		info.Phase = "working"
	}
	return info
}

// ParseDshSession mirrors parseDshSession。
func ParseDshSession(text, fallbackSessionID string) SessionInfo {
	info := SessionInfo{Phase: "unknown", SessionID: fallbackSessionID}
	permissionMode := ""
	prio := -1
	for _, e := range JsonlEvents(text, 1000) {
		data := sh.Nullish(e.Get("data"), util.NewObj())
		context := sh.Nullish(get(data, "context"), get(data, "request"), util.NewObj())
		if info.SessionID == "" {
			info.SessionID = or(str(e.Get("id")), str(e.Get("sessionId")))
		}
		if info.Cwd == "" {
			info.Cwd = or(str(e.Get("cwd")), str(get(data, "cwd")))
		}
		info.Model = or(str(get(data, "model")), str(get(data, "modelName")), str(get(data, "modelAlias")), str(get(context, "model")),
			str(get(get(data, "message"), "model")), info.Model)
		info.ReasoningEffort = or(str(get(data, "reasoningEffort")), str(get(data, "reasoning_effort")), str(get(data, "effort")),
			str(get(context, "reasoningEffort")), str(get(context, "reasoning_effort")), str(get(context, "effort")),
			str(get(data, "thinkingLevel")), str(get(context, "thinkingLevel")), info.ReasoningEffort)
		typ := e.Get("type")
		if typ == "permission/preset" && str(get(data, "preset")) != "" && prio < 3 {
			permissionMode, prio = str(get(data, "preset")), 3
		}
		if typ == "sandbox/mode" && str(get(data, "mode")) != "" && prio < 2 {
			permissionMode, prio = str(get(data, "mode")), 2
		}
		if typ == "approval/policy" && str(get(data, "policy")) != "" && prio < 1 {
			permissionMode, prio = str(get(data, "policy")), 1
		}
		if info.Title == "" && typ == "session/title" {
			info.Title = title(str(get(data, "title")))
		}
		if info.Title == "" && (typ == "user/message" || typ == "agent/inbox/spliced") {
			content := get(data, "content")
			if content == nil {
				content = dshInserted(get(data, "inserted"))
			}
			t := ""
			switch content.(type) {
			case string, []any:
				t = gemini.Text(content)
			}
			if t == "" {
				t = ctext(content)
			}
			info.Title = title(t)
		}
		if typ == "turn/end" {
			info.Phase = "turn-done"
		} else if typ == "assistant/message" {
			info.Phase = "working"
		}
		if at := ts(sh.Nullish(e.Get("time"), e.Get("timestamp"))); at != nil && *at != 0 {
			info.LastAt = at
		}
	}
	if permissionMode != "" {
		info.PermissionMode = &permissionMode
	}
	return info
}

// dshInserted mirrors (data.inserted)?.[0]?.content。
func dshInserted(v any) any {
	switch x := v.(type) {
	case []any:
		if len(x) > 0 {
			return get(x[0], "content")
		}
	case *util.Obj:
		return get(x.Get("0"), "content")
	}
	return nil
}

// StatusInput mirrors StatusInput（Alive nil = undefined）。
type StatusInput struct {
	Phase   LastPhase
	Alive   *bool
	AgeMs   float64
	StallMs float64
}

// DecideStatus mirrors decideStatus。
func DecideStatus(i StatusInput) AgentStatus {
	phase, ageMs, stallMs := i.Phase, i.AgeMs, i.StallMs
	if phase == "error" {
		return "failed"
	}
	if i.Alive != nil && !*i.Alive {
		if phase == "turn-done" || phase == "task-done" {
			return "completed"
		}
		return "idle"
	}
	if phase == "task-done" {
		return "completed"
	}
	if phase == "turn-done" {
		if i.Alive != nil || ageMs < stallMs {
			return "waiting"
		}
		return "idle"
	}
	if phase == "working" || phase == "tool" {
		if ageMs <= stallMs {
			return "running"
		}
		if i.Alive != nil && phase == "tool" {
			return "stalled"
		}
		return "idle"
	}
	if i.Alive == nil {
		if ageMs < 60_000 {
			return "running"
		}
		return "idle"
	}
	if ageMs < 60_000 {
		return "running"
	}
	return "waiting"
}

// DshProjcache mirrors Omit<SessionInfo,'phase'> from parseDshProjcache（Cwd nil = undefined）。
type DshProjcache struct {
	Cwd                   *string
	Title, PermissionMode string
}

// ParseDshProjcache mirrors parseDshProjcache。
func ParseDshProjcache(raw string) DshProjcache {
	v, err := util.ParseString(raw)
	if err != nil {
		return DshProjcache{}
	}
	if v == nil {
		return DshProjcache{} // null.record 抛错被 catch
	}
	record := get(v, "record")
	rows := get(record, "rows")
	ttl := ""
	if s, ok := get(get(rows, "title"), "val").(string); ok && s != "" {
		ttl = s
	} else if s, ok := get(get(get(get(rows, "titleInput"), "val"), "first"), "text").(string); ok && s != "" {
		ttl = s
	}
	out := DshProjcache{}
	if c, ok := get(get(record, "identity"), "cwd").(string); ok {
		out.Cwd = &c
	}
	if ttl != "" {
		out.Title = util.UTF16Slice0(ttl, 80)
	}
	perms := get(get(rows, "permissions"), "val")
	for _, k := range []string{"preset", "sandbox", "approval"} {
		if s, ok := get(perms, k).(string); ok && s != "" {
			out.PermissionMode = s
			break
		}
	}
	return out
}
