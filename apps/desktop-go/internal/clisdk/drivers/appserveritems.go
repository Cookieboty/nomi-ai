package drivers

import (
	"math"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CodexTurnPolicy mirrors codexTurnPolicy。
func CodexTurnPolicy(mode string, network bool) Json {
	workspace := func() Json {
		return O("type", "workspaceWrite", "writableRoots", []any{}, "networkAccess", network, "excludeTmpdirEnvVar", false, "excludeSlashTmp", false)
	}
	switch mode {
	case "plan":
		return O("sandboxPolicy", O("type", "readOnly", "networkAccess", false), "approvalPolicy", "never", "approvalsReviewer", "user")
	case "manual":
		return O("sandboxPolicy", workspace(), "approvalPolicy", "untrusted", "approvalsReviewer", "user")
	case "auto":
		return O("sandboxPolicy", workspace(), "approvalPolicy", "on-request", "approvalsReviewer", "auto_review")
	case "bypass":
		return O("sandboxPolicy", O("type", "dangerFullAccess"), "approvalPolicy", "never", "approvalsReviewer", "user")
	}
	return O("sandboxPolicy", workspace(), "approvalPolicy", "never", "approvalsReviewer", "user")
}

var itemStatus = map[string]string{"inProgress": "in_progress", "completed": "completed", "failed": "failed", "declined": "failed", "interrupted": "failed"}

var upper = regexp.MustCompile(`[A-Z]`)

func snake(s string) string {
	return upper.ReplaceAllStringFunc(s, func(c string) string { return "_" + strings.ToLower(c) })
}

// set：JS 对象字面量 {k: v}，v 为 undefined 时 JSON 中省略（这里 undefined = 源对象缺该键）。
type kv struct {
	k   string
	v   any
	def bool // false = undefined
}

func src(o Json, k string) kv { return kv{"", o.Get(k), o.Has(k)} }

func obj(pairs ...kv) Json {
	r := O()
	for _, p := range pairs {
		if p.def {
			if u, ok := p.v.(undefinedV); ok {
				_ = u
				continue
			}
			r.Set(p.k, p.v)
		}
	}
	return r
}

type undefinedV struct{}

func f(k string, p kv) kv    { p.k = k; return p }
func val(k string, v any) kv { return kv{k, v, true} }
func optStr(k string, v any) kv {
	if s, ok := v.(string); ok {
		return kv{k, s, true}
	}
	return kv{k: k}
}

// CodexExecItem mirrors codexExecItem（nil = null 结果）。
func CodexExecItem(item Json) Json {
	id := optStr("id", item.Get("id"))
	var status kv
	if s, ok := item.Get("status").(string); ok {
		if m, ok := itemStatus[s]; ok {
			status = val("status", m)
		} else {
			status = val("status", s)
		}
	} else {
		status = kv{k: "status"}
	}
	switch item.Get("type") {
	case "agentMessage":
		return obj(val("type", "agent_message"), id, f("text", src(item, "text")))
	case "reasoning":
		var parts []string
		for _, k := range []string{"summary", "content"} {
			if arr, ok := item.Get(k).([]any); ok {
				for _, x := range arr {
					if s, ok := x.(string); ok {
						parts = append(parts, s)
					}
				}
			}
		}
		return obj(val("type", "reasoning"), id, val("text", strings.Join(parts, "\n")))
	case "commandExecution":
		return obj(val("type", "command_execution"), id, f("command", src(item, "command")),
			f("aggregated_output", src(item, "aggregatedOutput")), f("exit_code", src(item, "exitCode")), status)
	case "fileChange":
		return obj(val("type", "file_change"), id, f("changes", src(item, "changes")), status)
	case "mcpToolCall":
		return obj(val("type", "mcp_tool_call"), id, f("server", src(item, "server")), f("tool", src(item, "tool")),
			f("arguments", src(item, "arguments")), f("result", src(item, "result")), f("error", src(item, "error")), status)
	case "collabAgentToolCall":
		tool := f("tool", src(item, "tool"))
		if s, ok := item.Get("tool").(string); ok {
			tool = val("tool", snake(s))
		}
		states := O()
		each := func(k string, v any) {
			st := getp(v, "status")
			stv := kv{"status", st, hasp(v, "status")}
			if st == "errored" {
				stv = val("status", "failed")
			}
			states.Set(k, obj(stv, kv{"message", getp(v, "message"), hasp(v, "message")}))
		}
		switch s := item.Get("agentsStates").(type) {
		case *util.Obj:
			for _, k := range s.Keys() {
				each(k, s.Get(k))
			}
		case []any:
			for i, v := range s {
				each(util.FormatNumber(float64(i)), v)
			}
		case string:
			for i := 0; i < clisdk.Len(s); i++ {
				each(util.FormatNumber(float64(i)), nil)
			}
		}
		return obj(val("type", "collab_tool_call"), id, tool, status,
			f("sender_thread_id", src(item, "senderThreadId")), f("receiver_thread_ids", src(item, "receiverThreadIds")),
			f("prompt", src(item, "prompt")), val("agents_states", states))
	case "webSearch":
		return obj(val("type", "web_search"), id, f("query", src(item, "query")))
	case "imageGeneration":
		return obj(val("type", "image_generation_call"), id, f("result", src(item, "result")), optStr("output", item.Get("savedPath")))
	}
	return nil
}

func hasp(v any, k string) bool {
	if o, ok := v.(*util.Obj); ok {
		return o.Has(k)
	}
	return false
}

// CodexApprovalSummary mirrors codexApprovalSummary。
func CodexApprovalSummary(method string, params Json) string {
	c := func(s string) string { return clip(s, 200) }
	if method == "item/commandExecution/requestApproval" {
		cmd, _ := params.Get("command").(string)
		if cmd != "" {
			return c("bash: " + cmd)
		}
		return c("bash")
	}
	why, _ := params.Get("reason").(string)
	root, _ := params.Get("grantRoot").(string)
	second := why
	if second == "" {
		second = root
	}
	if second == "" {
		return c("apply_patch")
	}
	return c("apply_patch: " + second)
}

// CodexTokenTotals mirrors CodexTokenTotals。
type CodexTokenTotals struct{ InputTokens, CachedInputTokens, OutputTokens float64 }

func finite(v any) float64 {
	if f, ok := v.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) {
		return f
	}
	return 0
}

func CodexTokenTotalsOf(tokenUsage any) *CodexTokenTotals {
	total := getp(tokenUsage, "total")
	if !util.Truthy(total) {
		return nil
	}
	t, ok := total.(*util.Obj)
	if !ok {
		if _, arr := total.([]any); !arr {
			return nil
		}
		return &CodexTokenTotals{} // 数组也是 object：各字段读出 undefined → 0
	}
	return &CodexTokenTotals{finite(t.Get("inputTokens")), finite(t.Get("cachedInputTokens")), finite(t.Get("outputTokens"))}
}

// CodexLastContext mirrors codexLastContext（nil = null）。
func CodexLastContext(tokenUsage any) Json {
	n := func(v any) (float64, bool) { return posNum(v) }
	last := getp(tokenUsage, "last")
	isObj := false
	switch last.(type) {
	case *util.Obj, []any:
		isObj = true
	}
	var ct float64
	hasCT := false
	if isObj {
		if t, ok := n(getp(last, "totalTokens")); ok {
			ct, hasCT = t, true
		} else {
			in, _ := n(getp(last, "inputTokens"))
			out, _ := n(getp(last, "outputTokens"))
			if s := in + out; s != 0 && !math.IsNaN(s) {
				ct, hasCT = s, true
			}
		}
	}
	cw, hasCW := n(getp(tokenUsage, "modelContextWindow"))
	if !hasCT && !hasCW {
		return nil
	}
	r := O()
	if hasCT {
		r.Set("contextTokens", ct)
	}
	if hasCW {
		r.Set("contextWindow", cw)
	}
	return r
}

// CodexTurnUsage mirrors codexTurnUsage（nil = undefined）。
func CodexTurnUsage(before, after *CodexTokenTotals) Json {
	if after == nil {
		return nil
	}
	b := CodexTokenTotals{}
	if before != nil {
		b = *before
	}
	return O("inputTokens", math.Max(0, after.InputTokens-b.InputTokens),
		"outputTokens", math.Max(0, after.OutputTokens-b.OutputTokens),
		"cacheReadTokens", math.Max(0, after.CachedInputTokens-b.CachedInputTokens))
}
