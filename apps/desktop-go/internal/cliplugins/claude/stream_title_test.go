package claude

import "testing"

func TestParseLineSessionTitleEvents(t *testing.T) {
	evs := ParseLine(`{"type":"custom-title","customTitle":"Claude Custom Title","session_id":"s1"}`, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "session-info" || evs[0].Get("title") != "Claude Custom Title" {
		t.Fatalf("custom-title parsed = %v", evs)
	}

	evs2 := ParseLine(`{"type":"summary","summary":"Claude Summary Title"}`, &StreamState{})
	if len(evs2) != 1 || evs2[0].Get("type") != "session-info" || evs2[0].Get("title") != "Claude Summary Title" {
		t.Fatalf("summary parsed = %v", evs2)
	}

	// Subagent title events must never overwrite the main conversation title.
	sub := ParseLine(`{"type":"custom-title","customTitle":"Subagent Title","parent_tool_use_id":"toolu_1"}`, &StreamState{})
	if len(sub) != 0 {
		t.Fatalf("subagent custom-title should be ignored, got %v", sub)
	}
}
