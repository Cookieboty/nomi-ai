package aisdk

// 工具循环的上下文守护：按上一步上游报的真实输入用量判断，快满时缩短较早的工具结果；
// 上游以超出上下文长度拒绝时缩得更狠、重发这一步一次。

import (
	"context"
	"errors"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

func toolMsg(id, out string) *u.Obj {
	return u.NewObj("role", "tool", "content", []any{u.NewObj("type", "tool-result", "toolCallId", id, "toolName", "look",
		"output", u.NewObj("type", "text", "value", out))})
}

func toolText(m *u.Obj) string {
	return m.Get("content").([]any)[0].(*u.Obj).Get("output").(*u.Obj).Get("value").(string)
}

func TestContextGuardUsesRealUsage(t *testing.T) {
	big := strings.Repeat("x", 4000)
	msgs := []*u.Obj{u.NewObj("role", "user", "content", "hi")}
	for i := 0; i < guardKeepRecent+2; i++ {
		msgs = append(msgs, toolMsg("c", big))
	}
	g := newContextGuard(100_000, "")
	// 第一步还没有真实用量：不动
	if out := g.prepare(msgs); toolText(out[1]) != big {
		t.Fatal("compacted without real usage")
	}
	// 上游报的真实用量离预算还远：不动（估算再大也不按估算判断）
	g.observe(10_000)
	if out := g.prepare(msgs); toolText(out[1]) != big {
		t.Fatal("compacted below the threshold")
	}
	// 真实用量到了 95%：较早的工具结果缩短，最近 guardKeepRecent 条保留全文
	g.observe(96_000)
	out := g.prepare(msgs)
	if toolText(out[1]) == big || !strings.Contains(toolText(out[1]), "已省略") || toolText(out[2]) == big {
		t.Fatal("older tool results not shortened")
	}
	for _, m := range out[len(out)-guardKeepRecent:] {
		if toolText(m) != big {
			t.Fatal("recent tool results must keep their full text")
		}
	}
	// 累积列表不改（工具记录里留全文）
	if toolText(msgs[1]) != big {
		t.Fatal("prepare must not modify the accumulated messages")
	}
	// 开始缩短后一直按同样规则缩短，即使上游报的用量降下来
	g.observe(50_000)
	if out := g.prepare(append(msgs, toolMsg("d", big))); toolText(out[1]) == big {
		t.Fatal("compaction must stay on once started")
	}
	// 没有预算：不守护
	if newContextGuard(0, "") != nil {
		t.Fatal("guard without a budget")
	}
	var none *contextGuard
	none.observe(1)
	if none.prepare(msgs)[1] != msgs[1] || none.overflow(msgs) != nil {
		t.Fatal("nil guard must be a no-op")
	}
}

func TestContextGuardOverflowOnce(t *testing.T) {
	big := strings.Repeat("y", 4000)
	msgs := []*u.Obj{u.NewObj("role", "user", "content", "hi"), toolMsg("a", big), toolMsg("b", big)}
	g := newContextGuard(100_000, "")
	next := g.overflow(msgs)
	if next == nil || toolText(next[1]) == big || toolText(next[2]) != big {
		t.Fatal("overflow must shorten all but the latest tool result")
	}
	// 只重试一次
	if g.overflow(msgs) != nil {
		t.Fatal("retried twice")
	}
	// 没有可缩的：照常报错
	if newContextGuard(100_000, "").overflow([]*u.Obj{u.NewObj("role", "user", "content", big)}) != nil {
		t.Fatal("nothing to shorten")
	}
}

func TestIsContextOverflow(t *testing.T) {
	body := func(s string) *string { return &s }
	yes := []error{
		&llm.APICallError{Message: "Bad Request", StatusCode: 400, ResponseBody: body(`{"error":{"code":"context_length_exceeded","message":"This model's maximum context length is 8192 tokens"}}`)},
		&llm.APICallError{Message: "prompt is too long: 210000 tokens > 200000 maximum", StatusCode: 400},
		&llm.RetryError{Errors: []error{&llm.APICallError{Message: "input is too long for requested model", StatusCode: 413}}},
		errors.New("The input token count (1200000) exceeds the maximum number of tokens allowed"),
	}
	for _, e := range yes {
		if !IsContextOverflow(e) {
			t.Fatalf("not detected: %v", e)
		}
	}
	no := []error{
		&llm.APICallError{Message: "rate limit: too many tokens per minute", StatusCode: 429},
		&llm.APICallError{Message: "Internal error: context window", StatusCode: 500},
		&llm.APICallError{Message: "invalid api key", StatusCode: 401},
		nil,
	}
	for _, e := range no {
		if IsContextOverflow(e) {
			t.Fatalf("false positive: %v", e)
		}
	}
}

// 上游以超长拒绝：缩短较早的工具结果后重发这一步，这一轮照常答完、不报错
func TestProviderRetriesStepAfterContextOverflow(t *testing.T) {
	run := func(budget float64) (seen []mockllm.Seen, text string, errs []string) {
		s, err := mockllm.StartScripted(nil)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		s.Set([]mockllm.Step{toolCallStep("c1"), toolCallStep("c2"),
			{Status: 400, Body: `{"error":{"message":"This model's maximum context length is 8192 tokens","type":"invalid_request_error","code":"context_length_exceeded"}}`},
			{OK: "1", SSE: sse(`{"id":"d","choices":[{"index":0,"delta":{"content":"done"}}]}`,
				`{"id":"d","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)}})
		p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		defs := []tools.Definition{{Name: "look", Description: "look", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
			n++
			return strings.Repeat(string(rune('A'+n)), 4000), nil
		}}}
		_ = p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r", ContextBudget: budget,
			Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
			func(c blm.ChatChunk) {
				switch c.Type {
				case "delta":
					text += c.Content
				case "error":
					errs = append(errs, *c.Error)
				}
			})
		return s.Seen(), text, errs
	}
	seen, text, errs := run(100_000)
	if len(seen) != 4 || text != "done" || len(errs) != 0 {
		t.Fatalf("requests %d text %q errors %v", len(seen), text, errs)
	}
	retry := seen[3].Body
	// 较早的工具结果缩短了，最近一步的保留全文
	if strings.Contains(retry, strings.Repeat("B", 4000)) || !strings.Contains(retry, "已省略") ||
		!strings.Contains(retry, strings.Repeat("C", 4000)) {
		t.Fatal(retry[:min(len(retry), 600)])
	}
	// 没有预算（不守护）：照常报错，不重试
	seen, _, errs = run(0)
	if len(seen) != 3 || len(errs) != 1 {
		t.Fatalf("requests %d errors %v", len(seen), errs)
	}
}

// 跨轮：上一轮结束时真实用量过了 60%，最近 3 轮之前的工具结果缩短；之后截断点不动，发出的前缀不变
func TestContextGuardElidesEarlierTurns(t *testing.T) {
	big := strings.Repeat("z", 4000)
	user := func(s string) *u.Obj { return u.NewObj("role", "user", "content", s) }
	turnMsgs := func(n int) []*u.Obj {
		var out []*u.Obj
		for i := 0; i < n; i++ {
			out = append(out, user("q"), toolMsg("t"+string(rune('a'+i)), big))
		}
		return append(out, user("now"))
	}
	key := "conv-elide"
	saveConvState(key, convState{})
	// 用量不高：不动
	g := newContextGuard(100_000, key)
	g.conv.lastPrompt = 10_000
	if out := g.prepare(turnMsgs(4)); toolText(out[1]) != big {
		t.Fatal("elided below the threshold")
	}
	g.finish()
	// 上一轮结束时到了 60%：最近 3 次用户消息之前的工具结果（ta、tb）缩短，之后的（tc、td）保留全文
	saveConvState(key, convState{lastPrompt: 70_000})
	g = newContextGuard(100_000, key)
	msgs := turnMsgs(4)
	out := g.prepare(msgs)
	if toolText(out[1]) == big || toolText(out[3]) == big || toolText(out[5]) != big || toolText(out[7]) != big {
		t.Fatal("wrong cut")
	}
	if toolText(msgs[1]) != big {
		t.Fatal("accumulated messages modified")
	}
	g.finish()
	first := u.Stringify(out[1])
	// 下一轮：用量降下来了，截断点不动，同一段前缀原样缩短（缓存不断）
	saveConvState(key, convState{lastPrompt: 30_000, cut: loadConvState(key).cut})
	g = newContextGuard(100_000, key)
	out2 := g.prepare(append(turnMsgs(4), toolMsg("te", big), user("next")))
	if u.Stringify(out2[1]) != first || toolText(out2[5]) != big {
		t.Fatal("prefix changed while the cut stayed")
	}
	// 截断点被压缩掉了（找不到那条工具结果）：从头来，不缩短
	g = newContextGuard(100_000, key)
	g.conv = convState{lastPrompt: 10_000, cut: "gone"}
	if out := g.prepare(turnMsgs(4)); toolText(out[1]) != big {
		t.Fatal("stale cut applied")
	}
}

// 有效预算很大时，60% 仍很高；绝对上限让旧工具结果更早缩短，截断点规则不变
func TestContextGuardAbsoluteHistoryCap(t *testing.T) {
	big := strings.Repeat("z", 4000)
	user := func(s string) *u.Obj { return u.NewObj("role", "user", "content", s) }
	var msgs []*u.Obj
	for i := 0; i < 4; i++ {
		msgs = append(msgs, user("q"), toolMsg("t"+string(rune('a'+i)), big))
	}
	msgs = append(msgs, user("now"))
	key := "conv-abs"
	saveConvState(key, convState{lastPrompt: 50_000})
	g := newContextGuard(1_000_000, key)
	if out := g.prepare(msgs); toolText(out[1]) != big {
		t.Fatal("elided below the absolute cap")
	}
	saveConvState(key, convState{lastPrompt: 70_000})
	g = newContextGuard(1_000_000, key)
	out := g.prepare(msgs)
	if toolText(out[1]) == big || toolText(out[5]) != big {
		t.Fatal("absolute cap did not keep the recent turns")
	}
	if g.historyLimit() != historyAbsTokens {
		t.Fatalf("limit %v", g.historyLimit())
	}
}

// 缩短工具结果之后仍然快满：这一轮较早的步骤换成摘要，最近几步保留原样，工具调用与结果仍成对
func TestContextGuardSummarizesTurn(t *testing.T) {
	big := strings.Repeat("w", 3000)
	asst := func(id string) *u.Obj {
		return u.NewObj("role", "assistant", "content", []any{u.NewObj("type", "tool-call", "toolCallId", id, "toolName", "look", "input", u.NewObj())})
	}
	step := []*u.Obj{u.NewObj("role", "user", "content", "do it")}
	for i := 0; i < 8; i++ {
		id := "s" + string(rune('a'+i))
		step = append(step, asst(id), toolMsg(id, big))
	}
	var gotTranscript string
	calls := 0
	g := newContextGuard(100_000, "")
	g.turnBase = 1
	g.summarize = func(_, transcript string) (string, error) {
		calls++
		gotTranscript = transcript
		return "read 4 files, found the bug in a.go", nil
	}
	g.observe(50_000)
	g.prepare(step) // 记下基线
	// 第一次快满：先缩短工具结果，不摘要
	g.observe(97_000)
	g.prepare(step)
	if g.keep == 0 || calls != 0 {
		t.Fatalf("keep %d calls %d", g.keep, calls)
	}
	// 缩短之后还是快满：摘要
	g.observe(97_000)
	out := g.prepare(step)
	if calls != 1 || !strings.Contains(gotTranscript, "[tool call look]") {
		t.Fatalf("calls %d transcript %q", calls, gotTranscript)
	}
	// 用户消息 + 带摘要的那一步 + 之后 3 步（每步一对），共 1 + 4*2
	if len(out) != 1+summaryKeepSteps*2 {
		t.Fatalf("len %d", len(out))
	}
	first := out[1].Get("content").([]any)
	if !strings.Contains(u.Stringify(first[0]), "found the bug") || first[1].(*u.Obj).Get("type") != "tool-call" {
		t.Fatal(u.Stringify(out[1]))
	}
	for i := 1; i < len(out); i += 2 {
		if out[i].Get("role") != "assistant" || out[i+1].Get("role") != "tool" {
			t.Fatal("tool calls and results must stay paired")
		}
	}
	// 之后各步照样带着摘要；累积列表不变
	if len(g.condense(append(step, asst("sz"), toolMsg("sz", "x")))) != 1+summaryKeepSteps*2+2 || len(step) != 17 {
		t.Fatal("condense not sticky")
	}
	// 摘要失败：这一轮不再试
	g2 := newContextGuard(100_000, "")
	g2.turnBase, g2.keep = 1, guardKeepRecent
	g2.summarize = func(string, string) (string, error) { return "", errors.New("down") }
	if g2.trySummarize(step) || g2.trySummarize(step) || g2.summaries != maxTurnSummaries {
		t.Fatal("failed summary must not be retried")
	}
}

// 接到 provider 上：上游每步报的真实用量一直很高 → 先缩短、再摘要；这一轮的工具记录与最后一次请求一致（带摘要）
func TestProviderSummarizesWhenStillFull(t *testing.T) {
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	usage := `{"id":"u","choices":[],"usage":{"prompt_tokens":97000,"completion_tokens":5}}`
	call := func(id string) mockllm.Step {
		return mockllm.Step{OK: "1", SSE: sse(`{"id":"`+id+`","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"`+id+`","type":"function","function":{"name":"look","arguments":"{}"}}]}}]}`,
			`{"id":"`+id+`","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`, usage)}
	}
	script := []mockllm.Step{}
	for i := 0; i < 9; i++ {
		script = append(script, call("k"+string(rune('a'+i))))
	}
	script = append(script, mockllm.Step{OK: "1", SSE: sse(`{"id":"d","choices":[{"index":0,"delta":{"content":"done"}}]}`,
		`{"id":"d","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`, usage)})
	s.Set(script)
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defs := []tools.Definition{{Name: "look", Description: "look", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
		return strings.Repeat("r", 3000), nil
	}}}
	sums := 0
	var steps string
	err = p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r", ContextBudget: 100_000,
		Summarize: func(context.Context, string, string) (string, error) { sums++; return "SUMMARY-OF-EARLIER-STEPS", nil },
		Messages:  []blm.ChatMessage{{Role: "user", Content: "go"}}},
		func(c blm.ChatChunk) {
			if c.Type == "steps" {
				steps = c.Steps
			}
		})
	if err != nil {
		t.Fatal(err)
	}
	if sums == 0 {
		t.Fatal("never summarized")
	}
	last := s.Seen()[len(s.Seen())-1].Body
	if !strings.Contains(last, "SUMMARY-OF-EARLIER-STEPS") || !strings.Contains(steps, "SUMMARY-OF-EARLIER-STEPS") {
		t.Fatalf("summary missing; steps=%d chars", len(steps))
	}
	// 摘要掉的早期调用不在记录里了
	if strings.Contains(steps, `"ka"`) {
		t.Fatal("early steps still in the record")
	}
}
