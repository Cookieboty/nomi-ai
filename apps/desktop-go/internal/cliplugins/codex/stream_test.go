package codex

import (
	"testing"
)

func TestParseLineExtractsTurnFailedObjectMessage(t *testing.T) {
	evs := ParseLine(`{"type":"turn.failed","error":{"message":"stream disconnected before completion: connection reset by peer"}}`)
	if len(evs) != 1 || evs[0].Get("type") != "error" ||
		evs[0].Get("message") != "stream disconnected before completion: connection reset by peer" {
		t.Fatalf("got %v", evs)
	}
}
