package claude

import "testing"

func TestParseAskUserQuestion(t *testing.T) {
	line := `{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"用哪种？","options":[{"label":"保留"}]}]}}}`
	evs := ParseLine(line, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "question" || evs[0].Get("id") != "r1" {
		t.Fatalf("events = %v", evs)
	}
	bash := `{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}`
	evs = ParseLine(bash, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "permission" {
		t.Fatalf("bash = %v", evs)
	}
}
