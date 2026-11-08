package aisdk

// 场景演练：用脚本模拟几种典型的模型行为，跑完整的工具循环，统计用户体验类的指标——
// 用户要不要说「继续」、有没有原样重复的调用、生图调了几次、空转时会不会停。
// 指标看的是运行时的兜底是否生效，不评估模型质量。

import (
	"context"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

type scenarioMetrics struct {
	Requests int
	// ContinueNeeded：这一轮结束时计划还没做完（用户得说「继续」）
	ContinueNeeded bool
	// Nudges：运行时提醒「计划没做完」的次数
	Nudges int
	// DuplicateCalls：名字与参数都和之前一样的工具调用
	DuplicateCalls int
	// ImageCalls：生图调用次数
	ImageCalls int
	// StoppedNoProgress：续轮没有进展，被运行时停下
	StoppedNoProgress bool
}

func runScenario(t *testing.T, maxSteps int, script []mockllm.Step) scenarioMetrics {
	t.Helper()
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	s.Set(script)
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m", MaxSteps: &maxSteps}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := scenarioMetrics{}
	ok := func(context.Context, any, tools.ExecContext) (any, error) { return "ok", nil }
	img := func(context.Context, any, tools.ExecContext) (any, error) {
		m.ImageCalls++
		return u.NewObj("ok", true, "image", "chat-asset://images/nomi-x.png"), nil
	}
	defs := []tools.Definition{{Name: "plan_update", Description: "plan", Execute: ok},
		{Name: "look", Description: "look", Execute: ok}, {Name: "image_generate", Description: "img", Execute: img}}
	var steps, text string
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r", Messages: []blm.ChatMessage{{Role: "user", Content: "make 2 posters"}}},
		func(c blm.ChatChunk) {
			switch c.Type {
			case "steps":
				steps = c.Steps
			case "delta":
				text += c.Content
			}
		}); err != nil {
		t.Fatal(err)
	}
	m.Requests = len(s.Seen())
	// 每个请求都带着之前的提醒：按最后一个请求里的数
	if n := len(s.Seen()); n > 0 {
		m.Nudges = strings.Count(s.Seen()[n-1].Body, "Automatic reminder")
	}
	msgs := parseSteps(steps)
	seen := map[string]bool{}
	for _, c := range toolCallsIn(msgs) {
		if seen[c.key] {
			m.DuplicateCalls++
		}
		seen[c.key] = true
	}
	m.ContinueNeeded = len(unfinishedPlan(msgs)) > 0
	m.StoppedNoProgress = strings.Contains(text, "进展") || strings.Contains(text, "progress")
	return m
}

func planArgs(statuses ...string) string {
	items := []string{}
	for i, st := range statuses {
		items = append(items, `{\"step\":\"poster `+string(rune('1'+i))+`\",\"status\":\"`+st+`\"}`)
	}
	return `"{\"items\":[` + strings.Join(items, ",") + `]}"`
}

func imgArgs(prompt string) string { return `"{\"prompt\":\"` + prompt + `\"}"` }

func TestScenarios(t *testing.T) {
	cases := []struct {
		name     string
		maxSteps int
		script   []mockllm.Step
		check    func(scenarioMetrics) bool
	}{
		{
			// 做了一半就说「好了」：运行时提醒一次，接着把第二张做完，用户不用说「继续」
			name: "lazy model finishes after a nudge", maxSteps: 20,
			script: []mockllm.Step{
				callStep("p1", "plan_update", planArgs("in_progress", "pending")),
				callStep("i1", "image_generate", imgArgs("poster one")),
				textStep("here is the first poster"),
				callStep("i2", "image_generate", imgArgs("poster two")),
				callStep("p2", "plan_update", planArgs("done", "done")),
				textStep("both posters are ready"),
			},
			check: func(m scenarioMetrics) bool {
				return !m.ContinueNeeded && m.Nudges == 1 && m.ImageCalls == 2 && m.DuplicateCalls == 0
			},
		},
		{
			// 一口气做完：不提醒、不多发请求
			name: "diligent model needs nothing", maxSteps: 20,
			script: []mockllm.Step{
				callStep("p1", "plan_update", planArgs("in_progress", "pending")),
				callStep("i1", "image_generate", imgArgs("poster one")),
				callStep("i2", "image_generate", imgArgs("poster two")),
				callStep("p2", "plan_update", planArgs("done", "done")),
				textStep("done"),
			},
			check: func(m scenarioMetrics) bool {
				return m.Requests == 5 && m.Nudges == 0 && !m.ContinueNeeded && m.ImageCalls == 2
			},
		},
		{
			// 原地打转：步数用完后续轮，这一轮只是原样重复之前的调用 → 停下，不再空转
			name: "looping model is stopped", maxSteps: 2,
			script: []mockllm.Step{
				callStep("l1", "look", `"{}"`), callStep("l2", "look", `"{\"x\":1}"`),
				callStep("l3", "look", `"{}"`), callStep("l4", "look", `"{\"x\":1}"`),
				callStep("l5", "look", `"{}"`), callStep("l6", "look", `"{}"`),
			},
			check: func(m scenarioMetrics) bool {
				return m.StoppedNoProgress && m.Requests == 4
			},
		},
		{
			// 提醒之后还是什么都不做：只提醒一次，然后把话交还给用户（不无限提醒）
			name: "stubborn model gets one reminder", maxSteps: 20,
			script: []mockllm.Step{
				callStep("p1", "plan_update", planArgs("in_progress", "pending")),
				textStep("I need the brand colors first"), textStep("still need them"), textStep("x"),
			},
			check: func(m scenarioMetrics) bool {
				return m.Requests == 3 && m.Nudges == 1
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if m := runScenario(t, c.maxSteps, c.script); !c.check(m) {
				t.Fatalf("%+v", m)
			}
		})
	}
}
