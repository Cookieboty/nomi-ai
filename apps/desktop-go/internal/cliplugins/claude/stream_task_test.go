package claude

import "testing"

func TestParseTaskTerminalProgressEndsAgent(t *testing.T) {
	line := `{"type":"system","subtype":"task_progress","task_id":"agent-1","status":"failed","description":"子任务失败"}`
	evs := ParseLine(line, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "agent" || evs[0].Get("op") != "end" || evs[0].Get("id") != "agent-1" || evs[0].Get("status") != "failed" {
		t.Fatalf("events = %v", evs)
	}
}

func TestParseTaskErrorEndsAgent(t *testing.T) {
	line := `{"type":"error","task_id":"agent-2","status":"error","message":"子任务失败"}`
	evs := ParseLine(line, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "agent" || evs[0].Get("op") != "end" || evs[0].Get("id") != "agent-2" || evs[0].Get("status") != "failed" {
		t.Fatalf("events = %v", evs)
	}
}
