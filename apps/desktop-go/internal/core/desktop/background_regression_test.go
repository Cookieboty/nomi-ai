package desktop

import (
	"context"
	"testing"
)

func TestBackgroundAutoAllReviewFailureAsks(t *testing.T) {
	for _, tc := range []struct {
		name       string
		verdict    *CommandReview
		noReviewer bool
	}{
		{name: "failed review"},
		{name: "missing reviewer", noReviewer: true},
		{name: "unknown risk", verdict: &CommandReview{Risk: "unknown", Outcome: "ask"}},
		{name: "high risk", verdict: &CommandReview{Risk: "high", Outcome: "ask"}},
		{name: "critical risk", verdict: &CommandReview{Risk: "critical", Outcome: "ask"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _, _ := reviewBroker(t, tc.verdict)
			if tc.noReviewer {
				b.Reviewer = nil
			}
			// 全局审核开关关着也不能在审核不可用时直接执行。
			b.AIReview = func() bool { return false }
			asked := 0
			ctx := WithBackground(context.Background(), &BackgroundRun{
				Level: 3, AutoJudge: true, AutoAll: func() bool { return true },
				Ask: func(string, string, string) bool { asked++; return false },
			})
			got := runCmdText(b, ctx, "rm -rf /w/customer-data")
			if got != "denied" || asked != 1 {
				t.Fatalf("decision=%s asked=%d, want denied/1", got, asked)
			}
		})
	}
}

func TestBackgroundExplicitAutoJudgeFalseAsks(t *testing.T) {
	for _, tc := range []struct {
		name      string
		live      bool
		whitelist bool
	}{
		{name: "snapshot"},
		{name: "live grant", live: true},
		{name: "whitelist", whitelist: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _, _ := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
			if tc.whitelist {
				b.AddCommandRule("pnpm test")
			}
			asked := 0
			run := &BackgroundRun{
				Level: 3, AutoJudge: false,
				Ask: func(string, string, string) bool { asked++; return false },
			}
			if tc.live {
				run.AutoJudge = true // 当前授权必须优先于旧快照。
				run.Live = func() (LiveGrant, bool) { return LiveGrant{Level: 3, AutoJudge: false}, true }
			}
			got := runCmdText(b, WithBackground(context.Background(), run), "pnpm test")
			if got != "denied" || asked != 1 {
				t.Fatalf("AutoJudge=false, global AIReview=true: decision=%s asked=%d, want denied/1", got, asked)
			}
		})
	}
}

func TestBackgroundAutoAllOverridesManualWithReviewedRisk(t *testing.T) {
	b, _, inputs := reviewBroker(t, &CommandReview{Risk: "low", Outcome: "allow"})
	b.AIReview = func() bool { return false }
	ctx := WithBackground(context.Background(), &BackgroundRun{
		Level: 3, AutoJudge: false, AutoAll: func() bool { return true },
		Ask: func(string, string, string) bool { t.Error("safe reviewed command asked"); return false },
	})
	if got := runCmdText(b, ctx, "pnpm test"); got != "auto" || len(*inputs) != 1 {
		t.Fatalf("decision=%s reviews=%d, want auto/1", got, len(*inputs))
	}
}
