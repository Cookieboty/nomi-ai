package dsh

import "testing"

func TestParseLineSessionTitle(t *testing.T) {
	evs := ParseLine(`{"type":"session/title","data":{"title":"  修复登录问题  "}}`)
	if len(evs) != 1 || evs[0].Get("type") != "session-info" || evs[0].Get("title") != "  修复登录问题  " {
		t.Fatalf("session/title parsed = %v", evs)
	}
	evs2 := ParseLine(`{"type":"session_title","title":"Direct Title"}`)
	if len(evs2) != 1 || evs2[0].Get("type") != "session-info" || evs2[0].Get("title") != "Direct Title" {
		t.Fatalf("session_title parsed = %v", evs2)
	}
	if empty := ParseLine(`{"type":"session/title","data":{"title":""}}`); len(empty) != 0 {
		t.Fatalf("empty session/title should emit nothing, got %v", empty)
	}
}
