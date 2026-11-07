package airouter

import (
	"testing"
	"time"
)

func TestActiveChats(t *testing.T) {
	t0 := time.Unix(100, 0)
	h := &Handlers{aborts: map[string]*aborter{
		"r1": {ch: make(chan struct{}), conv: "c1", started: t0.Add(time.Second)},
		"r2": {ch: make(chan struct{}), conv: "c1", started: t0},                  // 同一个对话更早的一条
		"r3": {ch: make(chan struct{}), conv: "", started: t0},                    // 标题生成等辅助调用
		"r4": {ch: make(chan struct{}), conv: "c2", started: t0.Add(time.Minute)}, // 已经停了
	}}
	h.aborts["r4"].abort()
	got := h.ActiveChats()
	if len(got) != 1 || got[0].ConversationID != "c1" || !got[0].StartedAt.Equal(t0) {
		t.Fatalf("ActiveChats = %+v, want only c1 started at t0", got)
	}
	if conversationOf(map[string]any{"extra": map[string]any{"conversationId": "c9"}}) != "c9" ||
		conversationOf(map[string]any{"messages": []any{}}) != "" {
		t.Fatal("conversationOf")
	}
}
