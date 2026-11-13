// Package claude：Claude Code 插件（清单、网关条目、流式输出与会话记录解析）。
package claude

import (
	"regexp"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	. "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// StreamState：流式解析的跨行状态。
type StreamState struct {
	TextSeen    bool
	LastContext *float64
}

func anthropicRequestContext(u any) *float64 {
	o, ok := u.(*util.Obj)
	if !ok {
		return nil
	}
	var sum float64
	any := false
	for _, k := range []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"} {
		if v := sh.Num(o.Get(k)); v != nil {
			sum += *v
			any = true
		}
	}
	if !any {
		return nil
	}
	return &sum
}

func claudeContext(j *util.Obj, state *StreamState) (ctxTokens, ctxWindow *float64, model *string) {
	usage := util.AsObj(Coalesce(j.Get("usage"), util.NewObj()))
	var its []any
	if a, ok := usage.Get("iterations").([]any); ok {
		its = a
	}
	var last any
	if len(its) > 0 {
		last = its[len(its)-1]
	}
	ctxTokens = anthropicRequestContext(last)
	if ctxTokens == nil && state != nil {
		ctxTokens = state.LastContext
	}
	best := -1.0
	if mu, ok := j.Get("modelUsage").(*util.Obj); ok {
		for _, name := range mu.Keys() {
			m, _ := mu.Get(name).(*util.Obj)
			load := 0.0
			for _, k := range []string{"inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"} {
				if v := sh.Num(m.Get(k)); v != nil {
					load += *v
				}
			}
			if load > best {
				best = load
				n := name
				model = &n
				ctxWindow = sh.Num(m.Get("contextWindow"))
			}
		}
	}
	return
}

func parentID(j *util.Obj) *string { return OptStr(j.Get("parent_tool_use_id")) }

var reToolSep = regexp.MustCompile(`[_\s-]`)

func isAskUserTool(name string) bool {
	return util.JSLower(reToolSep.ReplaceAllString(name, "")) == "askuserquestion"
}

func claudeHasQuestions(in *util.Obj) bool {
	qs, _ := in.Get("questions").([]any)
	return len(qs) > 0
}

func claudeQuestionSummary(in *util.Obj, tool string) string {
	qs, _ := in.Get("questions").([]any)
	if len(qs) == 0 {
		return tool
	}
	if o := util.AsObj(qs[0]); o != nil {
		if q := strings.TrimSpace(util.Str(o.Get("question"))); q != "" {
			return Slice0(q, 120)
		}
	}
	return tool
}

// ParseLine：解析一行 stream-json 输出。
func ParseLine(line string, state *StreamState) []Ev {
	trimmed := JSTrim(line)
	out := []Ev{}
	if !strings.HasPrefix(trimmed, "{") {
		return out
	}
	pv, err := util.ParseString(trimmed)
	if err != nil {
		return out
	}
	j := util.AsObj(pv)
	if pv == nil {
		// JSON.parse('null') cannot happen ('{' prefix) — keep shape anyway.
		return out
	}
	typ := JSString(Coalesce(j.Get("type"), ""))
	switch {
	case typ == "stream_event":
		if parentID(j) != nil {
			return out
		}
		ev, _ := j.Get("event").(*util.Obj)
		cb, _ := ev.Get("content_block").(*util.Obj)
		if state != nil && state.TextSeen && ev.Get("type") == "content_block_start" && cb.Get("type") == "text" {
			out = append(out, O("type", "text-delta", "text", "\n\n"))
		}
		if d, ok := ev.Get("delta").(*util.Obj); ok && d.Get("type") == "text_delta" && util.Truthy(d.Get("text")) {
			out = append(out, O("type", "text-delta", "text", d.Get("text")))
			if state != nil {
				state.TextSeen = true
			}
		}
		if ev != nil && util.Truthy(ev.Get("content_block")) {
			out = append(out, sh.ImageEvent(ev.Get("content_block"), true, false)...)
		}
	case typ == "user":
		if j.Get("isMeta") != true {
			if ev := UserImageEvent(util.AsObj(j.Get("message")).Get("content"), util.Str(j.Get("uuid"))); ev != nil {
				out = append(out, ev)
			}
		}
	case typ == "assistant":
		msg, _ := j.Get("message").(*util.Obj)
		if state != nil && parentID(j) == nil {
			if ctx := anthropicRequestContext(msg.Get("usage")); ctx != nil {
				if state.LastContext == nil || *ctx != *state.LastContext {
					out = append(out, WithOpt(O("type", "context", "tokens", *ctx), "model", StrOr(msg.Get("model"))))
				}
				state.LastContext = ctx
			}
		}
		if text := extractText(msg.Get("content")); text != "" {
			if p := parentID(j); p != nil {
				// 子代理（Task / Agent）自己说的话：挂在派生它的调用下面，子任务侧栏里实时显示；
				// 不并进主回复的正文
				out = append(out, O("type", "agent-text", "text", text, "parentId", *p))
			} else {
				out = append(out, O("type", "text", "text", text))
				if state != nil {
					state.TextSeen = true
				}
			}
		}
		out = append(out, sh.ImageEvent(msg.Get("content"), true, false)...)
	case typ == "result":
		ctxT, ctxW, model := claudeContext(j, state)
		if state != nil {
			state.TextSeen = false
			state.LastContext = nil
		}
		var text string
		if s, ok := j.Get("result").(string); ok {
			text = s
		} else {
			text = sh.BlockText(j.Get("result"), 0)
		}
		base := sh.ParseUsage(j.Get("usage"), j.Get("total_cost_usd"), j.Get("duration_ms"))
		var usage Ev
		if base != nil {
			usage = WithOpt(base.Clone(), "contextTokens", ctxT, "contextWindow", ctxW, "model", model)
		}
		sub, subStr := j.Get("subtype").(string)
		failed := j.Get("is_error") == true || (subStr && strings.HasPrefix(sub, "error"))
		if failed {
			msg := text
			if msg == "" {
				if j.Get("subtype") != nil {
					msg = JSString(j.Get("subtype"))
				} else {
					msg = T("electron.common.claude-error")
				}
			}
			// 出错的一轮也带上会话 id：续接靠它（否则下一轮成了新会话）
			out = append(out, WithOpt(O("type", "error", "message", msg), "sessionId", OptStr(j.Get("session_id"))))
		} else {
			image := sh.ImageMarkdown(j.Get("result"), true)
			out = append(out, WithOpt(WithOpt(O("type", "done", "text", sh.TextWithImage(text, image)), "sessionId", StrOr(j.Get("session_id"))), "usage", usage))
		}
	case typ == "system" && j.Get("subtype") == "init":
		// 进程一启动就报会话 id：第一轮还没结束（甚至出错结束）也能续接。
		// 子代理（带 parent_tool_use_id）的 init 是它自己的会话，不能顶掉主会话的 id
		if sid := OptStr(j.Get("session_id")); sid != nil && parentID(j) == nil {
			out = append(out, O("type", "session", "sessionId", *sid))
		}
	case typ == "system" && j.Get("subtype") == "api_retry":
		out = append(out, WithOpt(O("type", "status", "kind", "retry"),
			"attempt", sh.Num(j.Get("attempt")), "max", sh.Num(j.Get("max_retries")), "text", StrOr(j.Get("error"))))
	case typ == "system" && j.Get("subtype") == "status":
		kind := "clear"
		if j.Get("status") == "compacting" {
			kind = "compact"
		}
		ev := O("type", "status", "kind", kind)
		if m, ok := j.Get("permissionMode").(string); ok && m != "" {
			ev.Set("permissionMode", m)
		}
		out = append(out, ev)
	case typ == "system" && strings.HasPrefix(util.Str(j.Get("subtype")), "task_") && util.IsStr(j.Get("task_id")):
		if ev := taskEvent(j); ev != nil {
			out = append(out, ev)
		}
	case typ == "system" && j.Get("subtype") == "compact_boundary":
		out = append(out, O("type", "status", "kind", "clear"))
		meta := util.AsObj(Coalesce(j.Get("compact_metadata"), j.Get("compactMetadata"), util.NewObj()))
		post := sh.Num(meta.Get("post_tokens"))
		if post == nil {
			post = sh.Num(meta.Get("postTokens"))
		}
		var tok any
		if post != nil {
			tok = *post
		}
		out = append(out, O("type", "context", "tokens", tok))
		if state != nil {
			state.LastContext = post
		}
	case typ == "error" || (typ == "system" && j.Get("subtype") == "error"):
		m := Coalesce(j.Get("error"), j.Get("message"))
		msg := T("electron.common.claude-error")
		if m != nil {
			msg = JSString(m)
		}
		out = append(out, O("type", "error", "message", msg))
	case typ == "control_request":
		reqID := util.Str(j.Get("request_id"))
		req := util.AsObj(Coalesce(j.Get("request"), util.NewObj()))
		if reqID != "" && req.Get("subtype") == "can_use_tool" {
			tool := JSString(Coalesce(req.Get("tool_name"), "tool"))
			// AskUserQuestion 走问题卡，不走允许 / 拒绝。没有 questions 时仍当普通权限，避免这一轮挂住。
			if isAskUserTool(tool) {
				if in, ok := req.Get("input").(*util.Obj); ok && claudeHasQuestions(in) {
					ev := O("type", "question", "id", reqID, "toolName", tool, "input", in,
						"summary", claudeQuestionSummary(in, tool))
					if s := OptStr(req.Get("tool_use_id")); s != nil {
						ev.Set("toolUseId", *s)
					}
					out = append(out, ev)
					break
				}
			}
			detail := ""
			switch in := req.Get("input").(type) {
			case *util.Obj:
				detail = Slice0(JSString(Coalesce(in.Get("command"), in.Get("file_path"), in.Get("path"), in.Get("plan"), "")), 120)
			case []any:
				detail = Slice0(JSString(Coalesce(nil, "")), 120)
			case string:
				detail = Slice0(in, 120)
			}
			exitPlan := util.JSLower(reToolSep.ReplaceAllString(tool, "")) == "exitplanmode"
			summary := tool
			if detail != "" {
				summary = tool + ": " + detail
			}
			ev := O("type", "permission", "id", reqID, "summary", summary, "toolName", tool)
			if exitPlan {
				ev.Set("kind", "approve-plan")
			}
			if s := OptStr(req.Get("tool_use_id")); s != nil {
				ev.Set("toolUseId", *s)
			}
			out = append(out, ev)
		}
	}
	if typ == "assistant" || typ == "user" {
		msg, _ := j.Get("message").(*util.Obj)
		if content, ok := msg.Get("content").([]any); ok {
			for _, cv := range content {
				c := util.AsObj(cv)
				parent := parentID(j)
				if typ == "assistant" && c.Get("type") == "thinking" {
					if th, ok := c.Get("thinking").(string); ok && JSTrim(th) != "" {
						out = append(out, O("type", "thinking", "text", sh.Clip(th, sh.MaxThinking)))
					}
				}
				if typ == "assistant" && c.Get("type") == "tool_use" {
					out = append(out, WithOpt(WithOpt(O("type", "tool", "name", JSString(Coalesce(c.Get("name"), "tool")), "status", "start"),
						"detail", StrOr(c.Get("id"))), "input", sh.InputText(c.Get("input")), "parentId", parent))
				}
				if typ == "user" && c.Get("type") == "tool_result" {
					errd := c.Get("is_error") == true || c.Get("is_error") == "true"
					status := "done"
					if errd {
						status = "error"
					}
					out = append(out, WithOpt(WithOpt(O("type", "tool", "name", "tool", "status", status),
						"detail", StrOr(c.Get("tool_use_id"))), "output", sh.OutputText(c.Get("content")), "parentId", parent))
					out = append(out, sh.ImageEvent(c.Get("content"), true, false)...)
				}
			}
		}
	}
	return out
}

type lru struct {
	keys []string
	m    map[string]string
}

func newLRU() *lru { return &lru{m: map[string]string{}} }

func (l *lru) set(k, v string) {
	if _, ok := l.m[k]; !ok {
		l.keys = append(l.keys, k)
	}
	l.m[k] = v
	if len(l.m) > 500 {
		first := l.keys[0]
		l.keys = l.keys[1:]
		delete(l.m, first)
	}
}

func (l *lru) get(k string) (string, bool) { v, ok := l.m[k]; return v, ok }

func (l *lru) del(k string) {
	if _, ok := l.m[k]; !ok {
		return
	}
	delete(l.m, k)
	for i, x := range l.keys {
		if x == k {
			l.keys = append(l.keys[:i:i], l.keys[i+1:]...)
			break
		}
	}
}

var reAgentTool = regexp.MustCompile(`(?i)^(agent|task)$`)

// NewParser：带状态的逐行解析器。
func NewParser() func(line string) []Ev {
	names := newLRU()
	parents := newLRU()
	agents := newLRU()
	stream := &StreamState{}
	return func(line string) []Ev {
		evs := ParseLine(line, stream)
		for i, ev := range evs {
			typ := ev.Get("type")
			if typ == "permission" && util.Truthy(ev.Get("toolUseId")) {
				parent, ok := parents.get(util.Str(ev.Get("toolUseId")))
				if ok && parent != "" {
					agent, _ := agents.get(parent)
					if agent == "" {
						agent = T("electron.common.subagent-label")
					}
					evs[i] = ev.Clone().Set("agent", agent)
				}
				continue
			}
			detail := util.Str(ev.Get("detail"))
			if typ == "tool" && ev.Get("status") == "start" && detail != "" {
				if p := util.Str(ev.Get("parentId")); p != "" {
					parents.set(detail, p)
				}
				if reAgentTool.MatchString(util.JSIText(util.Str(ev.Get("name")))) {
					agents.set(detail, agentLabel(ev.Get("input")))
				}
			}
			if typ != "tool" || detail == "" {
				continue
			}
			if ev.Get("status") == "start" {
				names.m[detail] = util.Str(ev.Get("name"))
				continue
			}
			name, _ := names.m[detail]
			if name != "" {
				delete(names.m, detail)
				evs[i] = ev.Clone().Set("name", name)
			}
		}
		return evs
	}
}

func taskEvent(j *util.Obj) Ev {
	id := JSString(j.Get("task_id"))
	usage := sh.AgentUsage(j.Get("usage"))
	sub := j.Get("subtype")
	if sub == "task_started" {
		if j.Get("task_type") != "local_agent" && OptStr(j.Get("subagent_type")) == nil {
			return nil
		}
		var label *string
		if d := OptStr(j.Get("description")); d != nil {
			s := Slice0(*d, 120)
			label = &s
		}
		return WithOpt(O("type", "agent", "op", "start", "id", id, "status", "running"),
			"callId", OptStr(j.Get("tool_use_id")), "label", label, "agentType", OptStr(j.Get("subagent_type")),
			"background", j.Get("is_backgrounded") == true)
	}
	if sub == "task_progress" {
		p := OptStr(j.Get("description"))
		if p == nil {
			p = OptStr(j.Get("last_tool_name"))
		}
		var prog *string
		if p != nil {
			s := Slice0(*p, 120)
			prog = &s
		}
		return WithOpt(O("type", "agent", "op", "progress", "id", id), "callId", OptStr(j.Get("tool_use_id")), "progress", prog, "usage", usage)
	}
	patch := util.AsObj(Coalesce(j.Get("patch"), util.NewObj()))
	status, ok := sh.AgentEndStatus[JSString(Coalesce(j.Get("status"), patch.Get("status"), ""))]
	if (sub == "task_notification" || sub == "task_updated") && ok {
		var sum *string
		if s := OptStr(j.Get("summary")); s != nil {
			x := Slice0(*s, 2000)
			sum = &x
		}
		return WithOpt(O("type", "agent", "op", "end", "id", id, "status", status), "callId", OptStr(j.Get("tool_use_id")), "summary", sum, "usage", usage)
	}
	return nil
}

func agentLabel(input any) string {
	s, ok := input.(string)
	if !ok || s == "" {
		return ""
	}
	v, err := util.ParseString(s)
	if err != nil {
		return ""
	}
	o := util.AsObj(v)
	d := util.Str(o.Get("description"))
	if d == "" {
		d = util.Str(o.Get("subagent_type"))
	}
	return Slice0(d, 80)
}

func extractText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	arr, ok := content.([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, c := range arr {
		if o, ok := c.(*util.Obj); ok && o.Get("type") == "text" {
			b.WriteString(JSString(Coalesce(o.Get("text"), "")))
		}
	}
	return b.String()
}
