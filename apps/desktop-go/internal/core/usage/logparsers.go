package usage

// 逐行移植 apps/desktop-electron/internal/core/src/usage/logParsers.ts：编程工具会话日志 → 用量记录（纯函数，不碰文件系统）。

import (
	"math"
	"regexp"
	"runtime"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ParseState = Record<string, unknown>（值为 JSON 值：float64 / string / bool）。
type ParseState = map[string]any

func lpNum(v any) float64 {
	if x, ok := v.(float64); ok && !math.IsNaN(x) && !math.IsInf(x, 0) && x > 0 {
		return x
	}
	return 0
}

func lpStr(v any) *string {
	if s, ok := v.(string); ok && s != "" {
		return &s
	}
	return nil
}

func lpObj(v any) *util.Obj {
	if o, ok := v.(*util.Obj); ok && o != nil {
		return o
	}
	return nil
}

// oget：o?.k
func oget(o *util.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

// coalesce：a ?? b（Obj.Get 对缺失与 null 都返回 nil）
func coalesce(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

func firstStr(ps ...*string) *string {
	for _, p := range ps {
		if p != nil {
			return p
		}
	}
	return nil
}

func parseTs(v any) float64 {
	switch x := v.(type) {
	case float64:
		if x < 1e12 {
			return x * 1000
		}
		return x
	case string:
		t, ok := reminders.DateParse(x)
		if ok && !math.IsNaN(t) && !math.IsInf(t, 0) {
			return t
		}
		return 0
	}
	return 0
}

func jsonLine(l string) *util.Obj {
	s := util.JSTrim(l)
	if s == "" || s[0] != '{' {
		return nil
	}
	v, err := util.ParseString(s)
	if err != nil {
		return nil
	}
	return lpObj(v)
}

func lpLines(text string, needles []string) []*util.Obj {
	out := []*util.Obj{}
	for _, l := range strings.Split(text, "\n") {
		if needles != nil {
			hit := false
			for _, n := range needles {
				if strings.Contains(l, n) {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
		}
		if r := jsonLine(l); r != nil {
			out = append(out, r)
		}
	}
	return out
}

var trailingSlashes = regexp.MustCompile(`[\\/]+$`)

// nodeBasename：path.basename（当前平台；输入已去掉结尾分隔符）。
func nodeBasename(s string) string {
	if runtime.GOOS == "windows" {
		start := 0
		if len(s) >= 2 && s[1] == ':' && ((s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z')) {
			start = 2
		}
		rest := s[start:]
		if i := strings.LastIndexAny(rest, `/\`); i >= 0 {
			return rest[i+1:]
		}
		return rest
	}
	if i := strings.LastIndexByte(s, '/'); i >= 0 {
		return s[i+1:]
	}
	return s
}

func lpBase(p any) *string {
	s := lpStr(p)
	if s == nil {
		return nil
	}
	b := nodeBasename(trailingSlashes.ReplaceAllString(*s, ""))
	if b == "" {
		return nil
	}
	return &b
}

type toks struct{ input, output, cacheRead, cacheWrite float64 }

func (r toks) empty() bool {
	return r.input == 0 && r.output == 0 && r.cacheRead == 0 && r.cacheWrite == 0
}

func newRec(key string, ts float64, source string, provider *string, model string, t toks, session, project *string) *UsageRecord {
	return &UsageRecord{Key: key, Ts: ts, Source: source, Via: "log", Provider: provider, Model: model,
		Input: t.input, Output: t.output, CacheRead: t.cacheRead, CacheWrite: t.cacheWrite, Session: session, Project: project, keys: keysLogRec}
}

// 有序 Map<string, *UsageRecord>
type recOrder struct {
	keys []string
	m    map[string]*UsageRecord
}

func newRecOrder() *recOrder { return &recOrder{m: map[string]*UsageRecord{}} }
func (o *recOrder) set(k string, r *UsageRecord) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = r
}
func (o *recOrder) values() []UsageRecord {
	out := make([]UsageRecord, 0, len(o.keys))
	for _, k := range o.keys {
		out = append(out, *o.m[k])
	}
	return out
}

func stStr(state ParseState, k string) *string {
	if s, ok := state[k].(string); ok {
		return &s
	}
	return nil
}

func setIf(state ParseState, k string, v *string) {
	if v != nil {
		state[k] = *v
	}
}

// ---------------------------------------------------------------- Claude Code

func ParseClaudeChunk(text string) []UsageRecord {
	out := newRecOrder()
	for _, o := range lpLines(text, []string{`"usage"`}) {
		if o.Get("type") != "assistant" {
			continue
		}
		m := lpObj(o.Get("message"))
		u := lpObj(oget(m, "usage"))
		if m == nil || u == nil {
			continue
		}
		model := lpStr(m.Get("model"))
		if model == nil || *model == "<synthetic>" {
			continue
		}
		cc := lpObj(u.Get("cache_creation"))
		w5m := lpNum(oget(cc, "ephemeral_5m_input_tokens"))
		w1hRaw := lpNum(oget(cc, "ephemeral_1h_input_tokens"))
		cacheWrite := lpNum(u.Get("cache_creation_input_tokens"))
		if cacheWrite == 0 {
			cacheWrite = w5m + w1hRaw
		}
		rec := toks{lpNum(u.Get("input_tokens")), lpNum(u.Get("output_tokens")), lpNum(u.Get("cache_read_input_tokens")), cacheWrite}
		if rec.empty() {
			continue
		}
		cacheWrite1h := math.Min(w1hRaw, cacheWrite)
		fast := u.Get("speed") == "fast"
		id := firstStr(lpStr(m.Get("id")), lpStr(o.Get("requestId")), lpStr(o.Get("uuid")))
		if id == nil {
			continue
		}
		session := lpStr(o.Get("sessionId"))
		var key string
		if strings.HasPrefix(*id, "msg_") || session == nil {
			key = "claude:" + *id
		} else {
			key = "claude:" + *session + ":" + *id
		}
		if prev, ok := out.m[key]; ok {
			prev.Input = math.Max(prev.Input, rec.input)
			prev.Output = math.Max(prev.Output, rec.output)
			prev.CacheRead = math.Max(prev.CacheRead, rec.cacheRead)
			prev.CacheWrite = math.Max(prev.CacheWrite, rec.cacheWrite)
			p1h := 0.0
			if prev.CacheWrite1h != nil {
				p1h = *prev.CacheWrite1h
			}
			if w := math.Min(math.Max(p1h, cacheWrite1h), prev.CacheWrite); w != 0 {
				prev.CacheWrite1h = f64p(w)
				prev.setOwn("cacheWrite1h")
			}
			if fast {
				prev.Fast = boolp(true)
				prev.setOwn("fast")
			}
			continue
		}
		r := newRec(key, parseTs(o.Get("timestamp")), "claude", nil, *model, rec, session, lpBase(o.Get("cwd")))
		if cacheWrite1h != 0 {
			r.CacheWrite1h = f64p(cacheWrite1h)
		}
		if fast {
			r.Fast = boolp(true)
		}
		ks := []string{"key", "ts", "source", "via", "model", "input", "output", "cacheRead", "cacheWrite"}
		if cacheWrite1h != 0 {
			ks = append(ks, "cacheWrite1h")
		}
		if fast {
			ks = append(ks, "fast")
		}
		r.withKeys(append(ks, "session", "project"))
		out.set(key, r)
	}
	return out.values()
}

// ---------------------------------------------------------------- Codex

const forkReplayGapMs = 1000

var codexLines = []string{`"session_meta"`, `"turn_context"`, `"token_count"`}

func ParseCodexChunk(text string, state ParseState) []UsageRecord {
	out := []UsageRecord{}
	for _, l := range strings.Split(text, "\n") {
		wanted := false
		for _, n := range codexLines {
			if strings.Contains(l, n) {
				wanted = true
				break
			}
		}
		if !wanted && !(util.Truthy(state["forked"]) && util.Truthy(state["replay"])) {
			continue
		}
		o := jsonLine(l)
		if o == nil {
			continue
		}
		p := lpObj(o.Get("payload"))
		lineTs := parseTs(o.Get("timestamp"))
		if util.Truthy(state["forked"]) && util.Truthy(state["replay"]) {
			prev, hasPrev := state["prevTs"].(float64)
			if lineTs == 0 || (hasPrev && (lineTs < prev || lineTs-prev >= forkReplayGapMs)) {
				state["replay"] = false
			} else {
				state["prevTs"] = lineTs
			}
		}
		if !wanted {
			continue
		}
		typ := o.Get("type")
		if typ == "session_meta" && p != nil {
			if !util.Truthy(state["metaSeen"]) && !util.Truthy(state["sid"]) {
				state["metaSeen"] = true
				setIf(state, "sid", firstStr(lpStr(p.Get("session_id")), lpStr(p.Get("id"))))
				setIf(state, "cwd", lpStr(p.Get("cwd")))
				setIf(state, "provider", lpStr(p.Get("model_provider")))
				if lpStr(p.Get("forked_from_id")) != nil {
					state["forked"] = true
					state["replay"] = true
					if lineTs != 0 {
						state["prevTs"] = lineTs
						state["forkTs"] = lineTs
					}
				}
			}
		} else if typ == "turn_context" && p != nil {
			setIf(state, "model", lpStr(p.Get("model")))
			setIf(state, "cwd", lpStr(p.Get("cwd")))
		} else if typ == "event_msg" && oget(p, "type") == "token_count" {
			info := lpObj(p.Get("info"))
			last := lpObj(oget(info, "last_token_usage"))
			total := lpObj(oget(info, "total_token_usage"))
			if last == nil {
				continue
			}
			cum := lpNum(oget(total, "total_tokens"))
			if lt, ok := state["lastTotal"].(float64); cum != 0 && ok && cum == lt {
				continue
			}
			if cum != 0 {
				state["lastTotal"] = cum
			}
			if util.Truthy(state["forked"]) {
				skip := util.Truthy(state["replay"])
				if !skip && lineTs != 0 {
					if ft, ok := state["forkTs"].(float64); ok && lineTs < ft-1000 {
						skip = true
					}
				}
				if skip {
					continue
				}
			}
			cached := lpNum(last.Get("cached_input_tokens"))
			write := lpNum(last.Get("cache_write_input_tokens"))
			rec := toks{math.Max(0, lpNum(last.Get("input_tokens"))-cached-write), lpNum(last.Get("output_tokens")), cached, write}
			if rec.empty() {
				continue
			}
			sid := "unknown"
			if s := stStr(state, "sid"); s != nil {
				sid = *s
			}
			model := "unknown"
			if s := stStr(state, "model"); s != nil {
				model = *s
			}
			kn := cum
			if kn == 0 {
				kn = lineTs
			}
			var session *string
			if sid != "unknown" {
				session = strp(sid)
			}
			out = append(out, *newRec("codex:"+sid+":"+util.JSString(kn), lineTs, "codex", stStr(state, "provider"), model, rec, session, lpBase(state["cwd"])))
		}
	}
	return out
}

// CodexRateLimits：parseCodexRateLimits 的返回值。
type CodexRateLimits struct {
	Ts      float64       `json:"ts"`
	Windows []QuotaWindow `json:"windows"`
	Plan    *string       `json:"plan,omitempty"`
}

func ParseCodexRateLimits(text string) *CodexRateLimits {
	if !strings.Contains(text, "rate_limits") {
		return nil
	}
	var best *CodexRateLimits
	for _, o := range lpLines(text, []string{`"token_count"`}) {
		p := lpObj(o.Get("payload"))
		if o.Get("type") != "event_msg" || oget(p, "type") != "token_count" {
			continue
		}
		rl := lpObj(p.Get("rate_limits"))
		if rl == nil {
			continue
		}
		ts := parseTs(o.Get("timestamp"))
		windows := []QuotaWindow{}
		for _, id := range []string{"primary", "secondary"} {
			w := lpObj(rl.Get(id))
			used, ok := oget(w, "used_percent").(float64)
			if w == nil || !ok || math.IsNaN(used) || math.IsInf(used, 0) || used < 0 {
				continue
			}
			minutes := lpNum(w.Get("window_minutes"))
			at := parseTs(w.Get("resets_at"))
			inSec := lpNum(w.Get("resets_in_seconds"))
			resetAt := at
			if resetAt == 0 {
				if inSec != 0 && ts != 0 {
					resetAt = ts + float64(inSec*1000)
				} else {
					resetAt = 0
				}
			}
			qw := QuotaWindow{ID: id, UsedPercent: math.Min(100, used)}
			if minutes != 0 {
				qw.WindowMinutes = f64p(minutes)
			}
			if resetAt != 0 && !math.IsNaN(resetAt) {
				qw.ResetAt = f64p(resetAt)
			}
			windows = append(windows, qw)
		}
		if len(windows) == 0 {
			continue
		}
		if best == nil || ts >= best.Ts {
			best = &CodexRateLimits{Ts: ts, Windows: windows, Plan: lpStr(rl.Get("plan_type"))}
		}
	}
	return best
}

// ---------------------------------------------------------------- dsh

func ParseDshChunk(text string, state ParseState) []UsageRecord {
	out := []UsageRecord{}
	for _, o := range lpLines(text, nil) {
		d := lpObj(o.Get("data"))
		typ := o.Get("type")
		if typ == "session" {
			setIf(state, "sid", lpStr(o.Get("id")))
			setIf(state, "cwd", lpStr(o.Get("cwd")))
		} else if typ == "request/context" && d != nil {
			setIf(state, "model", lpStr(d.Get("model")))
			setIf(state, "provider", lpStr(d.Get("provider")))
		} else if typ == "assistant/message" && d != nil {
			u := lpObj(d.Get("usage"))
			if u == nil {
				continue
			}
			rec := toks{lpNum(u.Get("inputTokens")), lpNum(u.Get("outputTokens")), lpNum(u.Get("cacheReadTokens")), lpNum(u.Get("cacheWriteTokens"))}
			if rec.empty() {
				continue
			}
			sid := "unknown"
			if s := stStr(state, "sid"); s != nil {
				sid = *s
			}
			model := "unknown"
			if s := stStr(state, "model"); s != nil {
				model = *s
			}
			kn := lpNum(o.Get("seq"))
			if kn == 0 {
				kn = parseTs(o.Get("time"))
			}
			var session *string
			if sid != "unknown" {
				session = strp(sid)
			}
			out = append(out, *newRec("dsh:"+sid+":"+util.JSString(kn), parseTs(o.Get("time")), "dsh", stStr(state, "provider"), model, rec, session, lpBase(state["cwd"])))
		}
	}
	return out
}

// ---------------------------------------------------------------- Grok Build

func grokModelName(nodes ...*util.Obj) *string {
	for _, node := range nodes {
		if node == nil {
			continue
		}
		if mu := lpObj(node.Get("modelUsage")); mu != nil {
			for _, k := range mu.Keys() {
				if k != "" && k != "unknown" {
					return strp(k)
				}
			}
		}
		if mid := lpStr(node.Get("model")); mid != nil && *mid != "unknown" {
			return mid
		}
	}
	return nil
}

func ParseGrokChunk(text string, state ParseState) []UsageRecord {
	out := []UsageRecord{}
	for _, o := range lpLines(text, nil) {
		params := lpObj(o.Get("params"))
		if params == nil {
			params = o
		}
		update := lpObj(params.Get("update"))
		if update == nil {
			update = params
		}
		sessionUpdate := firstStr(lpStr(update.Get("sessionUpdate")), lpStr(params.Get("sessionUpdate")), lpStr(o.Get("sessionUpdate")))
		usage := lpObj(update.Get("usage"))
		if usage == nil {
			usage = lpObj(params.Get("usage"))
		}
		if usage == nil {
			usage = lpObj(o.Get("usage"))
		}
		seen := grokModelName(usage, update, params, o)
		if seen != nil {
			state["model"] = *seen
		}
		if sidEarly := firstStr(lpStr(o.Get("sessionId")), lpStr(params.Get("sessionId")), lpStr(update.Get("sessionId"))); sidEarly != nil {
			state["sid"] = *sidEarly
		}
		if sessionUpdate == nil || *sessionUpdate != "turn_completed" {
			continue
		}
		if usage == nil {
			continue
		}
		cacheRead := lpNum(coalesce(usage.Get("cachedReadTokens"), usage.Get("cacheReadTokens")))
		cacheWrite := lpNum(coalesce(usage.Get("cacheCreationTokens"), usage.Get("cacheWriteTokens")))
		inputRaw := lpNum(usage.Get("inputTokens"))
		rec := toks{math.Max(0, inputRaw-cacheRead-cacheWrite), lpNum(usage.Get("outputTokens")), cacheRead, cacheWrite}
		if rec.empty() {
			continue
		}
		meta := lpObj(params.Get("_meta"))
		tsv := coalesce(o.Get("timestamp"), o.Get("time"), update.Get("timestamp"))
		var promptID string
		if p := firstStr(lpStr(update.Get("prompt_id")), lpStr(update.Get("promptId")), lpStr(params.Get("prompt_id")), lpStr(oget(meta, "promptId"))); p != nil {
			promptID = *p
		} else {
			kn := lpNum(o.Get("seq"))
			if kn == 0 {
				kn = parseTs(tsv)
			}
			promptID = util.JSString(kn)
		}
		sid := "unknown"
		if s := stStr(state, "sid"); s != nil {
			sid = *s
		}
		model := "unknown"
		if seen != nil {
			model = *seen
		} else if c := stStr(state, "model"); c != nil && *c != "" && *c != "unknown" {
			model = *c
		}
		var session *string
		if sid != "unknown" {
			session = strp(sid)
		}
		out = append(out, *newRec("grok:"+sid+":"+promptID, parseTs(tsv), "grok", strp("xai"), model, rec, session, lpBase(state["cwd"])))
	}
	return out
}

// ---------------------------------------------------------------- Gemini CLI

func ParseGeminiFile(text string, fallbackCwd, fallbackSession *string) []UsageRecord {
	var msgs []any
	var sid *string
	var updated any
	var whole any
	if v, err := util.ParseString(text); err == nil {
		whole = v
	}
	w := lpObj(whole)
	if arr, ok := oget(w, "messages").([]any); w != nil && ok {
		msgs = arr
		sid = lpStr(w.Get("sessionId"))
		updated = w.Get("lastUpdated")
	} else {
		keys := []string{}
		byID := map[string]any{}
		set := func(k string, v any) {
			if _, ok := byID[k]; !ok {
				keys = append(keys, k)
			}
			byID[k] = v
		}
		n := 0
		nextN := func() string { s := "#" + util.JSString(float64(n)); n++; return s }
		for _, o := range lpLines(text, nil) {
			if sid == nil {
				sid = lpStr(o.Get("sessionId"))
			}
			updated = coalesce(o.Get("lastUpdated"), updated)
			if arr, ok := o.Get("messages").([]any); ok {
				for _, x := range arr {
					if id := lpStr(oget(lpObj(x), "id")); id != nil {
						set(*id, x)
					} else {
						set(nextN(), x)
					}
				}
				continue
			}
			if t := o.Get("type"); t != "gemini" && t != "model" {
				continue
			}
			if id := lpStr(o.Get("id")); id != nil {
				set(*id, o)
			} else {
				set(nextN(), o)
			}
		}
		for _, k := range keys {
			msgs = append(msgs, byID[k])
		}
	}
	session := "unknown"
	if p := firstStr(sid, fallbackSession); p != nil {
		session = *p
	}
	out := []UsageRecord{}
	for i, raw := range msgs {
		m := lpObj(raw)
		t := lpObj(oget(m, "tokens"))
		if m == nil || t == nil {
			continue
		}
		if mt := m.Get("type"); mt != "gemini" && mt != "model" {
			continue
		}
		cached := lpNum(t.Get("cached"))
		rec := toks{math.Max(0, lpNum(t.Get("input"))-cached) + lpNum(t.Get("tool")), lpNum(t.Get("output")) + lpNum(t.Get("thoughts")), cached, 0}
		if rec.empty() {
			continue
		}
		idPart := util.JSString(float64(i))
		if id := lpStr(m.Get("id")); id != nil {
			idPart = *id
		}
		ts := parseTs(m.Get("timestamp"))
		if ts == 0 {
			ts = parseTs(updated)
		}
		model := "unknown"
		if s := lpStr(m.Get("model")); s != nil {
			model = *s
		}
		var sess *string
		if session != "unknown" {
			sess = strp(session)
		}
		var fc any
		if fallbackCwd != nil {
			fc = *fallbackCwd
		}
		out = append(out, *newRec("gemini:"+session+":"+idPart, ts, "gemini", nil, model, rec, sess, lpBase(fc)).withKeys(keysLogNoProv))
	}
	return out
}

// ---------------------------------------------------------------- Aider

func ParseAiderChunk(text string) []UsageRecord {
	out := []UsageRecord{}
	for _, o := range lpLines(text, nil) {
		if o.Get("event") != "message_send" {
			continue
		}
		p := lpObj(o.Get("properties"))
		if p == nil {
			continue
		}
		rec := toks{lpNum(p.Get("prompt_tokens")), lpNum(p.Get("completion_tokens")), 0, 0}
		if rec.empty() {
			continue
		}
		ts := parseTs(o.Get("time"))
		model := "unknown"
		if s := lpStr(p.Get("main_model")); s != nil {
			model = *s
		}
		out = append(out, *newRec("aider:"+util.JSString(ts)+":"+util.JSString(rec.input)+":"+util.JSString(rec.output), ts, "aider", nil, model, rec, nil, nil).withKeys(keysAider))
	}
	return out
}

// ---------------------------------------------------------------- Qwen Code

func ParseQwenChunk(text string) []UsageRecord {
	out := newRecOrder()
	for _, o := range lpLines(text, nil) {
		if o.Get("type") != "assistant" {
			continue
		}
		u := lpObj(o.Get("usageMetadata"))
		uuid := lpStr(o.Get("uuid"))
		if u == nil || uuid == nil {
			continue
		}
		cached := lpNum(u.Get("cachedContentTokenCount"))
		rec := toks{math.Max(0, lpNum(u.Get("promptTokenCount"))-cached) + lpNum(u.Get("toolUsePromptTokenCount")),
			lpNum(u.Get("candidatesTokenCount")) + lpNum(u.Get("thoughtsTokenCount")), cached, 0}
		if rec.empty() {
			continue
		}
		key := "qwen:" + *uuid
		if prev, ok := out.m[key]; ok {
			prev.Input = math.Max(prev.Input, rec.input)
			prev.Output = math.Max(prev.Output, rec.output)
			prev.CacheRead = math.Max(prev.CacheRead, rec.cacheRead)
			continue
		}
		model := "unknown"
		if s := lpStr(o.Get("model")); s != nil {
			model = *s
		}
		out.set(key, newRec(key, parseTs(o.Get("timestamp")), "qwen", nil, model, rec, lpStr(o.Get("sessionId")), lpBase(o.Get("cwd"))).withKeys(keysLogNoProv))
	}
	return out.values()
}

// ---------------------------------------------------------------- Kimi

func kimiTokens(u *util.Obj) toks {
	if u.Get("inputOther") != nil || u.Get("input_other") != nil {
		return toks{
			lpNum(coalesce(u.Get("inputOther"), u.Get("input_other"))),
			lpNum(u.Get("output")),
			lpNum(coalesce(u.Get("inputCacheRead"), u.Get("input_cache_read"))),
			lpNum(coalesce(u.Get("inputCacheCreation"), u.Get("input_cache_creation"))),
		}
	}
	details := lpObj(u.Get("input_tokens_details"))
	hasRead := u.Get("cache_read_input_tokens") != nil
	cacheRead := lpNum(coalesce(u.Get("cache_read_input_tokens"), oget(details, "cached_tokens")))
	sub := cacheRead
	if hasRead {
		sub = 0
	}
	return toks{math.Max(0, lpNum(u.Get("input_tokens"))-sub), lpNum(u.Get("output_tokens")), cacheRead, lpNum(u.Get("cache_creation_input_tokens"))}
}

func ParseKimiChunk(text string, state ParseState) []UsageRecord {
	out := newRecOrder()
	for _, o := range lpLines(text, nil) {
		typ := lpStr(o.Get("type"))
		t := ""
		if typ != nil {
			t = *typ
		}
		if t == "llm.request" || t == "config.update" || t == "profile.bind" {
			if m := firstStr(lpStr(o.Get("modelAlias")), lpStr(o.Get("model"))); m != nil {
				parts := strings.Split(*m, "/")
				state["model"] = parts[len(parts)-1]
			}
		}
		msg := lpObj(o.Get("message"))
		event := o
		if t == "context.append_loop_event" {
			event = lpObj(o.Get("event"))
		}
		var usage *util.Obj
		var id *string
		ts := 0.0
		if oget(msg, "type") == "StatusUpdate" {
			p := lpObj(msg.Get("payload"))
			usage = lpObj(oget(p, "token_usage"))
			id = lpStr(oget(p, "message_id"))
			ts = parseTs(o.Get("timestamp"))
		} else if oget(event, "type") == "step.end" {
			usage = lpObj(event.Get("usage"))
			id = firstStr(lpStr(event.Get("messageId")), lpStr(event.Get("uuid")))
			ts = parseTs(coalesce(o.Get("time"), event.Get("time")))
		}
		if usage == nil || id == nil {
			continue
		}
		rec := kimiTokens(usage)
		if rec.empty() || ts == 0 || math.IsNaN(ts) {
			continue
		}
		key := "kimi:" + *id
		if prev, ok := out.m[key]; ok {
			prev.Input = math.Max(prev.Input, rec.input)
			prev.Output = math.Max(prev.Output, rec.output)
			prev.CacheRead = math.Max(prev.CacheRead, rec.cacheRead)
			prev.CacheWrite = math.Max(prev.CacheWrite, rec.cacheWrite)
			continue
		}
		model := "unknown"
		if s := stStr(state, "model"); s != nil {
			model = *s
		}
		out.set(key, newRec(key, ts, "kimi", nil, model, rec, stStr(state, "sid"), nil).withKeys(keysKimiCop))
	}
	return out.values()
}

// ---------------------------------------------------------------- SQLite 来源

func cell(v any) float64 {
	if x, ok := v.(int64); ok {
		return float64(x)
	}
	return lpNum(v)
}

func OpencodeRowToRecord(r *util.Obj) *UsageRecord {
	id := lpStr(r.Get("id"))
	if id == nil {
		return nil
	}
	rec := toks{cell(r.Get("input")), cell(r.Get("output")) + cell(r.Get("reasoning")), cell(r.Get("cache_read")), cell(r.Get("cache_write"))}
	if rec.empty() {
		return nil
	}
	ts := parseTs(cell(r.Get("created")))
	if ts == 0 {
		return nil
	}
	model := "unknown"
	if s := lpStr(r.Get("model")); s != nil {
		model = *s
	}
	return newRec("opencode:"+*id, ts, "opencode", lpStr(r.Get("provider")), model, rec, lpStr(r.Get("session_id")), lpBase(r.Get("cwd")))
}

var digitsRe = regexp.MustCompile(`^\d+$`)

func CopilotRowToRecord(r *util.Obj) *UsageRecord {
	id := cell(r.Get("id"))
	session := lpStr(r.Get("session_id"))
	if id == 0 || session == nil {
		return nil
	}
	total := cell(r.Get("input_tokens"))
	cacheRead := math.Min(cell(r.Get("cache_read_tokens")), total)
	cacheWrite := math.Min(cell(r.Get("cache_write_tokens")), total-cacheRead)
	rec := toks{total - cacheRead - cacheWrite, cell(r.Get("output_tokens")), cacheRead, cacheWrite}
	if rec.empty() {
		return nil
	}
	ca := r.Get("created_at")
	if s, ok := ca.(string); ok && digitsRe.MatchString(s) {
		ca = util.ToNumber(s)
	}
	ts := parseTs(ca)
	if ts == 0 || math.IsNaN(ts) {
		return nil
	}
	model := "unknown"
	if s := lpStr(r.Get("model")); s != nil {
		model = *s
	}
	return &UsageRecord{Key: "copilot:" + *session + ":" + util.JSString(id), Ts: ts, Source: "copilot", Via: "log", Model: model,
		Input: rec.input, Output: rec.output, CacheRead: rec.cacheRead, CacheWrite: rec.cacheWrite, Session: session, keys: keysKimiCop}
}

var LogSources = []string{"claude", "codex", "dsh", "grok", "gemini", "qwen", "opencode", "copilot", "kimi", "aider"}
