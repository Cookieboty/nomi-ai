package claude

import (
	"testing"
)

func TestParseLinePreservesExecutionErrorDetails(t *testing.T) {
	st := &StreamState{}
	// 1. api_retry 记下上游错误原因，随后的 error_during_execution（无 result）把它带出来
	_ = ParseLine(`{"type":"system","subtype":"api_retry","attempt":3,"max_retries":3,"error":"529 Overloaded"}`, st)
	evs := ParseLine(`{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s1"}`, st)
	if len(evs) != 1 || evs[0].Get("type") != "error" ||
		evs[0].Get("message") != "error_during_execution: 529 Overloaded" || evs[0].Get("sessionId") != "s1" {
		t.Fatalf("got %v", evs)
	}

	// 2. result 自带 errors 数组时优先展示 errors 数组内容
	evs2 := ParseLine(`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["API Error: 502 Bad Gateway","stream closed"]}`, st)
	if len(evs2) != 1 || evs2[0].Get("message") != "error_during_execution: API Error: 502 Bad Gateway; stream closed" {
		t.Fatalf("got %v", evs2)
	}
}
