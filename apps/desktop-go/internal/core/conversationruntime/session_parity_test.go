package conversationruntime

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestApprovalDetailsTraceAndFailedRequestExposure(t *testing.T) {
	f := newFakeRuntime("api")
	f.caps.Bridges = &CapabilityBridges{
		Computer:    BridgeState{Status: "native"},
		MCP:         BridgeState{Status: "native"},
		Persona:     BridgeState{Status: "native"},
		Memory:      BridgeState{Status: "native"},
		Knowledge:   BridgeState{Status: "native"},
		Skills:      BridgeState{Status: "native"},
		Attachments: BridgeState{Status: "bridged"},
	}
	f.caps.Attachments = true

	tgt := sessionTarget(f, "api")
	tgt.Env.Model = "claude-3-7"
	tgt.Effort = "high"

	c, err := NewSession("prod_conv", nil)
	expectErrIs(t, err, nil)
	expectErrIs(t, c.Select(tgt), nil)

	// Send with current-turn images allowed only when Bridges.Attachments is wired.
	tok := Request{MessageID: "u1", TurnID: "t1", Text: "check screenshot", Images: []string{"data:image/png;base64,AAAA"}}
	attemptToken, err := c.Start(context.Background(), tok)
	expectErrIs(t, err, nil)

	call := f.call(t, 0)
	if len(call.request.Images) != 1 || call.request.Images[0] != "data:image/png;base64,AAAA" {
		t.Fatalf("images not passed to wired runtime: %+v", call.request.Images)
	}
	expectErrIs(t, call.deliver(), nil)

	// Emit >maxActiveTraceEntries trace events and verify bounded slice without dirtying ledger.
	totalTraces := maxActiveTraceEntries + 6
	for i := 0; i < totalTraces; i++ {
		tr := &TraceEntry{ID: fmt.Sprintf("tr-%d", i), Kind: "tool", Tool: "fs_read_text", Status: "completed", At: int64(i)}
		ev := call.event(EventTrace)
		ev.Trace = tr
		expectErrIs(t, call.emit(ev), nil)
	}
	st := c.State()
	wantLast := fmt.Sprintf("tr-%d", totalTraces-1)
	if len(st.Trace) != maxActiveTraceEntries || st.Trace[0].ID != "tr-6" || st.Trace[maxActiveTraceEntries-1].ID != wantLast {
		t.Fatalf("trace buffer bounded incorrectly: len=%d first=%+v", len(st.Trace), st.Trace)
	}
	if len(c.Messages()) != 1 {
		t.Fatalf("trace events polluted authoritative ledger: %+v", c.Messages())
	}
	if st.Model != "claude-3-7" || st.Effort != "high" || st.PermissionMode != "ask" || st.AccountID == "" || !st.Capabilities.Attachments {
		t.Fatalf("runtime metadata missing from SessionState: %+v", st)
	}

	// Emit detailed approval metadata and verify Approve clears it.
	appEv := call.event(EventApproval)
	appEv.ApprovalID = "ap-1"
	appEv.ApprovalInfo = &ApprovalInfo{ID: "ap-1", Tool: "workspace_run", Summary: "Run tests", ArgsPreview: `{"command":"go test"}`, Danger: "destructive", Risk: "medium", Rationale: "runs tests"}
	expectErrIs(t, call.emit(appEv), nil)
	st = c.State()
	if len(st.ApprovalDetails) != 1 || st.ApprovalDetails[0].Tool != "workspace_run" || st.ApprovalDetails[0].Risk != "medium" {
		t.Fatalf("approval details missing: %+v", st.ApprovalDetails)
	}
	expectErrIs(t, c.Approve(context.Background(), attemptToken, "ap-1", true), nil)
	if len(c.State().ApprovalDetails) != 0 {
		t.Fatalf("approved item remained in ApprovalDetails: %+v", c.State().ApprovalDetails)
	}

	// Fail after delivery -> Uncertain -> exposes FailedRequest -> explicit abandon holds old message.
	failEv := call.event(EventFailed)
	failEv.Detail = "network dropped"
	_ = call.emit(failEv)
	st = c.State()
	if st.Phase != PhaseUncertain || st.FailedRequest == nil || st.FailedRequest.MessageID != "u1" || st.FailedRequest.TurnID != "t1" {
		t.Fatalf("failed request not exposed for retry/abandon: %+v", st)
	}

	expectErrIs(t, c.ResolveAbandon(&st.Generation), nil)
	after := c.State()
	if after.Phase != PhaseIdle || after.FailedRequest != nil || len(after.ApprovalDetails) != 0 {
		t.Fatalf("ResolveAbandon did not reset cleanly: %+v", after)
	}
	if !c.Checkpoint().Held["u1"] {
		t.Fatalf("abandoned request must remain held against automatic replay")
	}

	// Subsequent switch to a target without attachment bridge rejects images explicitly.
	noAtt := newFakeRuntime("claude")
	expectErrIs(t, c.Select(sessionTarget(noAtt, "claude")), nil)
	if _, err := c.Start(context.Background(), Request{MessageID: "u2", TurnID: "t2", Text: "img", Images: []string{"data:image/png;base64,BBBB"}}); !errors.Is(err, ErrBadEdit) {
		t.Fatalf("expected ErrBadEdit when backend lacks attachment bridge, got %v", err)
	}
}
