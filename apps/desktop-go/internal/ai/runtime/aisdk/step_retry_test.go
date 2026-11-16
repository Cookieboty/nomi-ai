package aisdk

import (
	"context"
	"errors"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type scriptedMemModel struct {
	steps [][]llm.StreamPart
	calls int
}

func (m *scriptedMemModel) Provider() string { return "mem" }
func (m *scriptedMemModel) ModelID() string  { return "mem-1" }
func (m *scriptedMemModel) DoGenerate(context.Context, llm.CallOptions) (*llm.GenerateResult, error) {
	return nil, errors.New("unused")
}
func (m *scriptedMemModel) DoStream(_ context.Context, _ llm.CallOptions) (*llm.StreamResult, error) {
	idx := m.calls
	m.calls++
	ch := make(chan llm.StreamPart, 16)
	if idx < len(m.steps) {
		for _, p := range m.steps[idx] {
			ch <- p
		}
	}
	close(ch)
	return &llm.StreamResult{Stream: ch}, nil
}

func TestStepStreamRetriesFiveMidStreamDropsAndCompletes(t *testing.T) {
	oldBase := StepStreamRetryBaseMs
	StepStreamRetryBaseMs = 0
	defer func() { StepStreamRetryBaseMs = oldBase }()

	fm := &scriptedMemModel{
		steps: [][]llm.StreamPart{
			// Step 1: 正常发起工具调用
			{
				{Type: "tool-call", ToolCallID: "c1", ToolName: "inspect", Input: `{"target":"w1"}`},
				{Type: "finish", FinishReason: &llm.FinishReason{Unified: "tool-calls"}},
			},
			// Step 2 (try 1): 网络读流 unexpected EOF
			{
				{Type: llm.PartStreamError, Err: errors.New("unexpected EOF")},
			},
			// Step 2 (retry 1): 思考输出一半静默断流（无 finish）
			{
				{Type: "reasoning-start", ID: "r1"},
				{Type: "reasoning-delta", ID: "r1", Delta: "analyzing w2..."},
			},
			// Step 2 (retry 2): compatible 适配器半截残缺工具调用 + 无 finish_reason 报错
			{
				{Type: "tool-call", ToolCallID: "bad_call", ToolName: "inspect", Input: `{"target":`},
				{Type: "error", Err: llm.NewInvalidResponseDataError(u.Undefined, "Response stream ended without a finish reason.")},
				{Type: "finish", FinishReason: &llm.FinishReason{Unified: "error"}},
			},
			// Step 2 (retry 3): 上游流内推送 overloaded_error
			{
				{Type: "error", RawValue: u.NewObj("type", "error", "error", u.NewObj("type", "overloaded_error", "message", "Overloaded"))},
				{Type: "finish", FinishReason: &llm.FinishReason{Unified: "error"}},
			},
			// Step 2 (retry 4): 空流静默关闭（NoOutputGeneratedError）
			{},
			// Step 2 (retry 5，第 5 次重试成功！): 正常总结收尾
			{
				{Type: "text-start", ID: "t1"},
				{Type: "text-delta", ID: "t1", Delta: "All milestones finished."},
				{Type: "finish", FinishReason: &llm.FinishReason{Unified: "stop"}},
			},
		},
	}

	p, err := NewProvider(Options{
		ID: "nomi-gateway", BaseURL: "http://127.0.0.1:0", APIKey: "k", DefaultModel: "mem-1", MaxRetries: new(int),
	}, func(string) llm.LanguageModel { return fm })
	if err != nil {
		t.Fatal(err)
	}

	toolExecs := 0
	defs := []tools.Definition{{
		Name: "inspect", Description: "inspect",
		Execute: func(context.Context, any, tools.ExecContext) (any, error) {
			toolExecs++
			return "ok-w1", nil
		},
	}}

	var errs, toolErrs []string
	var text, savedSteps string
	dones := 0
	err = p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{
		ReqID:    "r-long",
		Messages: []blm.ChatMessage{{Role: "user", Content: "finish long task"}},
	}, func(c blm.ChatChunk) {
		switch c.Type {
		case "error":
			if c.Error != nil {
				errs = append(errs, *c.Error)
			}
		case "tool_call.result":
			if c.Error != nil {
				toolErrs = append(toolErrs, *c.Error)
			}
		case "delta":
			text += c.Content
		case "steps":
			savedSteps = c.Steps
		case "done":
			dones++
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if fm.calls != 7 {
		t.Fatalf("expected 7 stream calls (step 1 + 1 initial + 5 retries), got %d", fm.calls)
	}
	if len(errs) != 0 || len(toolErrs) != 0 {
		t.Fatalf("unexpected leaked errors=%v toolErrs=%v", errs, toolErrs)
	}
	if toolExecs != 1 || dones != 1 || text != "All milestones finished." {
		t.Fatalf("toolExecs=%d dones=%d text=%q", toolExecs, dones, text)
	}
	if !strings.Contains(savedSteps, `"ok-w1"`) || strings.Contains(savedSteps, "bad_call") {
		t.Fatalf("unexpected savedSteps: %s", savedSteps)
	}
}

func TestExhaustedMidStreamRetriesStillPersistCompletedSteps(t *testing.T) {
	oldBase, oldMax := StepStreamRetryBaseMs, StepStreamMaxRetries
	StepStreamRetryBaseMs, StepStreamMaxRetries = 0, 5
	defer func() { StepStreamRetryBaseMs, StepStreamMaxRetries = oldBase, oldMax }()

	steps := [][]llm.StreamPart{
		// Step 1 成功执行工具
		{
			{Type: "tool-call", ToolCallID: "c1", ToolName: "inspect", Input: `{"step":1}`},
			{Type: "finish", FinishReason: &llm.FinishReason{Unified: "tool-calls"}},
		},
	}
	// Step 2 初始 + 连续 5 次重试全部断流（共 6 次）
	for i := 0; i < 6; i++ {
		steps = append(steps, []llm.StreamPart{{Type: llm.PartStreamError, Err: errors.New("connection reset by peer")}})
	}
	fm := &scriptedMemModel{steps: steps}

	p, err := NewProvider(Options{
		ID: "nomi-gateway", BaseURL: "http://127.0.0.1:0", APIKey: "k", DefaultModel: "mem-1", MaxRetries: new(int),
	}, func(string) llm.LanguageModel { return fm })
	if err != nil {
		t.Fatal(err)
	}
	defs := []tools.Definition{{
		Name: "inspect", Description: "inspect",
		Execute: func(context.Context, any, tools.ExecContext) (any, error) { return "saved-progress", nil },
	}}

	var gotErr, gotSteps string
	_ = p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{
		ReqID:    "r-exhaust",
		Messages: []blm.ChatMessage{{Role: "user", Content: "run"}},
	}, func(c blm.ChatChunk) {
		if c.Type == "error" && c.Error != nil {
			gotErr = *c.Error
		}
		if c.Type == "steps" {
			gotSteps = c.Steps
		}
	})
	if fm.calls != 7 {
		t.Fatalf("expected 1 + 6 calls (5 retries), got %d", fm.calls)
	}
	if !strings.Contains(gotErr, "connection reset by peer") {
		t.Fatalf("expected final error, got %q", gotErr)
	}
	if !strings.Contains(gotSteps, "saved-progress") {
		t.Fatalf("completed step progress was lost on mid-stream failure: %q", gotSteps)
	}
}
