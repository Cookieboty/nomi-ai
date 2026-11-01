package tasks

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

func toolsHarness(t *testing.T, decision string) (*Service, map[string]tools.Definition, *[]string) {
	now := time.Date(2026, 11, 2, 8, 30, 0, 0, time.Local).UnixMilli()
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Now: func() int64 { return now }, T: i18n.T,
		SetTimer: func(func(), int64) func() { return func() {} }})
	cards := []string{}
	defs := map[string]tools.Definition{}
	for _, d := range CreateTaskTools(s, func(_ context.Context, _, _ string, _ any, preview string) string {
		cards = append(cards, preview)
		return decision
	}, nil) {
		defs[d.Name] = d
	}
	return s, defs, &cards
}

func call(t *testing.T, d tools.Definition, in string, ec tools.ExecContext) map[string]any {
	t.Helper()
	var v any
	_ = json.Unmarshal([]byte(in), &v)
	out, err := d.Execute(context.Background(), v, ec)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(out)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func TestTaskProposeAndRecall(t *testing.T) {
	s, defs, cards := toolsHarness(t, "allowed")
	r := call(t, defs["task_propose"], `{"title":"看 CI","goal":"每天看 CI","when":{"kind":"daily","time":"09:00"},"tools":["read","web"]}`,
		tools.ExecContext{ConversationID: "conv_1"})
	if r["ok"] != true {
		t.Fatal(r)
	}
	if !strings.Contains((*cards)[0], "每天 09:00") || !strings.Contains((*cards)[0], "只读") {
		t.Fatal((*cards)[0])
	}
	id := r["data"].(map[string]any)["id"].(string)
	rec := s.Get(id)
	if rec.Task.Origin.CreatedBy != "nomi" || *rec.Task.Origin.ConversationID != "conv_1" || rec.Task.Grant.Level != 1 ||
		rec.Task.Trigger.Repeat == nil || rec.Task.Trigger.Repeat.Kind != "daily" {
		t.Fatalf("%+v", rec.Task)
	}
	got := call(t, defs["task_recall"], `{"id":"`+id+`"}`, tools.ExecContext{})
	if got["data"].(map[string]any)["title"] != "看 CI" {
		t.Fatal(got)
	}
	if list := call(t, defs["task_recall"], `{}`, tools.ExecContext{}); len(list["data"].(map[string]any)["tasks"].([]any)) != 1 {
		t.Fatal(list)
	}
	if miss := call(t, defs["task_recall"], `{"id":"task_x"}`, tools.ExecContext{}); miss["ok"] != false {
		t.Fatal(miss)
	}
}

func TestTaskProposeDeniedAndGuards(t *testing.T) {
	s, defs, cards := toolsHarness(t, "denied")
	in := `{"title":"t","goal":"g","when":{"kind":"manual"},"tools":["shell"]}`
	if r := call(t, defs["task_propose"], in, tools.ExecContext{}); r["ok"] != false {
		t.Fatal(r)
	}
	if !strings.Contains((*cards)[0], "跑命令") || len(s.List().Tasks) != 0 {
		t.Fatal(*cards)
	}
	if r := call(t, defs["task_propose"], in, tools.ExecContext{CallerTabID: "tab"}); r["error"].(map[string]any)["code"] != "not_allowed" {
		t.Fatal(r)
	}
	if _, err := TriggerOf(ProposeWhen{Kind: "once", At: "nope"}, 0); err == nil {
		t.Fatal("want error")
	}
}

func TestSpentToday(t *testing.T) {
	now := time.Date(2026, 11, 2, 10, 0, 0, 0, time.Local).UnixMilli()
	c1, c2 := 0.4, 0.3
	atts := []Attempt{
		{StartedAt: now - 3600_000, Usage: Usage{CostUsd: &c1}},
		{StartedAt: now - 30*3600_000, Usage: Usage{CostUsd: &c2}},
		{StartedAt: now - 60_000},
	}
	if v := SpentToday(atts, now); v != 0.4 {
		t.Fatal(v)
	}
}
