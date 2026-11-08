package aisdk

import (
	"context"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

func callStep(id, name, args string) mockllm.Step {
	return mockllm.Step{OK: "1", SSE: sse(`{"id":"`+id+`","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"`+id+`","type":"function","function":{"name":"`+name+`","arguments":`+args+`}}]}}]}`,
		`{"id":"`+id+`","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)}
}

func textStep(text string) mockllm.Step {
	return mockllm.Step{OK: "1", SSE: sse(`{"id":"t","choices":[{"index":0,"delta":{"content":"`+text+`"}}]}`,
		`{"id":"t","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)}
}

const openPlan = `"{\"items\":[{\"step\":\"read\",\"status\":\"done\"},{\"step\":\"fix the bug\",\"status\":\"in_progress\"}]}"`
const donePlan = `"{\"items\":[{\"step\":\"read\",\"status\":\"done\"},{\"step\":\"fix the bug\",\"status\":\"done\"}]}"`

func runPlanScript(t *testing.T, steps int, script []mockllm.Step) ([]mockllm.Seen, string) {
	t.Helper()
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	s.Set(script)
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m", MaxSteps: &steps}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ok := func(context.Context, any, tools.ExecContext) (any, error) { return "ok", nil }
	defs := []tools.Definition{{Name: "plan_update", Description: "plan", Execute: ok}, {Name: "look", Description: "look", Execute: ok}}
	text := ""
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r", Messages: []blm.ChatMessage{{Role: "user", Content: "fix it"}}},
		func(c blm.ChatChunk) {
			if c.Type == "delta" {
				text += c.Content
			}
		}); err != nil {
		t.Fatal(err)
	}
	return s.Seen(), text
}

// 计划没做完就收尾：提醒一次，接着做完
func TestPlanUnfinishedNudgesToContinue(t *testing.T) {
	seen, text := runPlanScript(t, 20, []mockllm.Step{
		callStep("p1", "plan_update", openPlan), callStep("l1", "look", `"{}"`), textStep("all good"),
		// 提醒之后：接着做、更新计划、收尾
		callStep("l2", "look", `"{}"`), callStep("p2", "plan_update", donePlan), textStep("fixed"),
	})
	if len(seen) != 6 || !strings.Contains(seen[3].Body, "Automatic reminder") || !strings.Contains(seen[3].Body, "fix the bug") {
		t.Fatalf("requests %d", len(seen))
	}
	if !strings.Contains(text, "fixed") {
		t.Fatal(text)
	}
}

// 提醒之后什么也没做又收尾：不再提醒（不空转）
func TestPlanNudgeNotRepeatedWithoutProgress(t *testing.T) {
	seen, _ := runPlanScript(t, 20, []mockllm.Step{
		callStep("p1", "plan_update", openPlan), textStep("done?"), textStep("still done"), textStep("never"),
	})
	if len(seen) != 3 {
		t.Fatalf("requests %d, want 3 (one nudge only)", len(seen))
	}
}

// 步数用完要续轮，但这一轮只改了计划：停下，不再空转
func TestAutoContinueStopsWithoutProgress(t *testing.T) {
	seen, text := runPlanScript(t, 2, []mockllm.Step{
		callStep("p1", "plan_update", openPlan), callStep("p2", "plan_update", openPlan), callStep("p3", "plan_update", openPlan),
	})
	if len(seen) != 2 || !strings.Contains(text, "auto-continue-stopped-no-progress") && !strings.Contains(text, "进展") && !strings.Contains(text, "progress") {
		t.Fatalf("requests %d text %q", len(seen), text)
	}
}
