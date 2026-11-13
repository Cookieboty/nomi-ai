package claude

import "testing"

// 子代理自己说的话变成 agent-text（挂在派生它的调用下），不再并进主回复
func TestParseSubagentTextStaysUnderItsCall(t *testing.T) {
	line := `{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"我先读一下 README"}]}}`
	state := &StreamState{}
	evs := ParseLine(line, state)
	if len(evs) != 1 || evs[0].Get("type") != "agent-text" || evs[0].Get("parentId") != "toolu_1" || evs[0].Get("text") != "我先读一下 README" {
		t.Fatalf("events = %v", evs)
	}
	if state.TextSeen {
		t.Fatal("subagent text counted as main text")
	}
	main := `{"type":"assistant","message":{"content":[{"type":"text","text":"好的"}]}}`
	evs = ParseLine(main, state)
	if len(evs) != 1 || evs[0].Get("type") != "text" {
		t.Fatalf("main = %v", evs)
	}
}
