package conversationruntime

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestResolveUnprovenResumeRequiresUnknownAndDoesNotResend(t *testing.T) {
	rt := newFakeRuntime("claude")
	c := testSession(t, rt, nil)
	ident := c.State().Capabilities // just to touch state
	_ = ident
	target := sessionTarget(rt, "claude")
	key := target.Identity.Key(target.Env)
	if err := c.bindings.Put(Binding{ID: "old", CompatKey: key, NativeSessionID: "native-old", Status: StatusIdle, Coverage: NewCoverage()}); err != nil {
		t.Fatal(err)
	}
	c.preferred[key] = "old"
	rt.setRecovery(func(_ context.Context, r RecoveryRequest) RecoveryResult {
		if r.Previous.NativeSessionID != "native-old" {
			t.Fatalf("should have attempted previous binding, got %+v", r.Previous)
		}
		return RecoveryResult{Kind: RecoveryUnknown, Detail: "cold resume unproven"}
	})
	_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "once"})
	if !errors.Is(err, ErrUnknownState) {
		t.Fatalf("expected unknown recovery, got %v", err)
	}
	if st := c.State(); st.Phase != PhaseUncertain || st.Recovery.Kind != RecoveryUnknown {
		t.Fatalf("state %+v", st)
	}
	recovers, starts, _ := rt.counts()
	if starts != 0 {
		t.Fatal("unknown recovery submitted a user turn")
	}
	gen := c.State().Generation
	wrong := gen + 1
	if err = c.ResolveUnprovenResume(&wrong); !errors.Is(err, ErrStaleEvent) {
		t.Fatal(err)
	}
	if err = c.ResolveUnprovenResume(&gen); err != nil {
		t.Fatal(err)
	}
	if st := c.State(); st.Phase != PhaseIdle {
		t.Fatalf("resolve left session unusable: %+v", st)
	}
	got, ok := c.bindings.Get("old")
	if !ok || got.NativeSessionID != "native-old" || got.Status != StatusStale || c.preferred[key] != "" {
		t.Fatalf("old native identity was clobbered: %+v preferred=%q", got, c.preferred[key])
	}
	if err = c.ResolveUnprovenResume(nil); !errors.Is(err, ErrUnresolved) {
		t.Fatal("repeat resolve must fail")
	}
	rt.setRecovery(nil)
	token, err := c.Start(context.Background(), Request{MessageID: "next", TurnID: "t2", Text: "next"})
	if err != nil {
		t.Fatal(err)
	}
	call := rt.call(t, 0)
	if call.request.Plan.Strategy != StrategyNewSession || call.request.NativeSessionID == "native-old" {
		t.Fatalf("expected new full session, got %+v", call.request)
	}
	if strings.Contains(call.request.Plan.Payload, "once") || strings.Contains(call.request.Plan.Handoff, "once") {
		t.Fatalf("unproven request leaked into the later unique current request: %+v", call.request.Plan)
	}
	if !strings.Contains(call.request.Plan.Payload, "next") {
		t.Fatalf("later unique request missing from full payload: %+v", call.request.Plan)
	}
	call.complete(t, "ok", Activity{Known: true})
	if c.State().Phase != PhaseCompleted || token.Generation == 0 {
		t.Fatalf("new native start failed: %+v", c.State())
	}
	recovers2, starts2, _ := rt.counts()
	if recovers2 != recovers+1 || starts2 != 1 {
		t.Fatalf("unexpected runtime traffic recovers=%d starts=%d", recovers2, starts2)
	}
	old, _ := c.bindings.Get("old")
	if old.NativeSessionID != "native-old" || old.Status != StatusStale {
		t.Fatal("later new session overwrote the abandoned binding")
	}
}
