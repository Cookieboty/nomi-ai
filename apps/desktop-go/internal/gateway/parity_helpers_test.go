package gateway_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func loadJSFixture(t *testing.T, name string) *u.Obj {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "parity", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v.(*u.Obj)
}

func rows(o *u.Obj, k string) [][]any {
	var out [][]any
	for _, r := range o.Get(k).([]any) {
		out = append(out, r.([]any))
	}
	return out
}

func numPtr(v any) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}

func intPtr(v any) *int {
	if f, ok := v.(float64); ok {
		i := int(f)
		return &i
	}
	return nil
}

func strPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func classifiedObj(c server.Classified) string {
	o := u.NewObj("outcome", c.Outcome)
	if c.ErrorKind != nil {
		o.Set("errorKind", *c.ErrorKind)
	}
	return u.Stringify(o)
}

func failureObj(f server.Failure) string {
	o := u.NewObj("kind", f.Kind)
	switch f.Kind {
	case "param":
		o.Set("param", f.Param)
	case "rectify":
		o.Set("fix", f.Fix)
		if f.Rejected != "" {
			o.Set("rejected", f.Rejected)
		}
	}
	return u.Stringify(o)
}

func usageOf(v any) *events.StreamUsage {
	o, _ := v.(*u.Obj)
	if o == nil {
		return nil
	}
	return &events.StreamUsage{InputTokens: numPtr(o.Get("inputTokens")), OutputTokens: numPtr(o.Get("outputTokens")),
		CacheReadTokens: numPtr(o.Get("cacheReadTokens")), CacheWriteTokens: numPtr(o.Get("cacheWriteTokens"))}
}

func calKey(v any) server.CalibrationKey {
	o := v.(*u.Obj)
	return server.CalibrationKey{SessionKey: u.JSString(o.Get("sessionKey")), ProviderID: u.JSString(o.Get("providerId")),
		Model: u.JSString(o.Get("model")), Wire: u.JSString(o.Get("wire"))}
}

func TestParityHelpers(t *testing.T) {
	fx := loadJSFixture(t, "helpers")
	tl := tally{}
	for _, r := range rows(fx, "estimate") {
		tl.add("estimateTokens", server.EstimateTokens(r[0].(string)) == r[1].(float64))
	}
	for _, r := range rows(fx, "reqTokens") {
		tl.add("estimateRequestTokens", server.EstimateRequestTokens(r[0]) == r[1].(float64))
	}
	server.ResetCalibration()
	for _, r := range rows(fx, "calib") {
		k := calKey(r[1])
		if r[0] == "record" {
			server.RecordUsage(k, r[2], r[3].(float64), numPtr(r[4]))
			continue
		}
		got := server.CalibratedCount(k, r[2], numPtr(r[4]))
		ok := got == r[5].(float64)
		if !ok {
			t.Logf("calib %v: got %v want %v", u.Stringify(r), got, r[5])
		}
		tl.add("calibratedCount", ok)
	}
	for _, r := range rows(fx, "measured") {
		tl.add("measuredInputTokens", server.MeasuredInputTokens(r[0].(string), usageOf(r[1])) == r[2].(float64))
	}
	for _, r := range rows(fx, "failures") {
		var applied []string
		for _, a := range r[3].([]any) {
			applied = append(applied, a.(string))
		}
		got := failureObj(server.ClassifyFailure(int(r[0].(float64)), r[1].(string), r[2], applied))
		want := u.Stringify(r[4])
		if got != want {
			t.Logf("classifyFailure %v: got %s want %s", u.Stringify(r[:4]), got, want)
		}
		tl.add("classifyFailure", got == want)
	}
	for _, r := range rows(fx, "attempts") {
		in := r[0].(*u.Obj)
		got := classifiedObj(server.ClassifyAttemptFailure(server.AttemptFailure{Status: int(in.Get("status").(float64)),
			UpstreamStatus: intPtr(in.Get("upstreamStatus")), Network: in.Get("network") == true,
			Text: strPtr(in.Get("text")), Message: strPtr(in.Get("message"))}))
		tl.add("classifyAttemptFailure", got == u.Stringify(r[1]))
	}
	for _, r := range rows(fx, "precommit") {
		tl.add("classifyPreCommit", classifiedObj(server.ClassifyPreCommit(int(r[0].(float64)), intPtr(r[1]))) == u.Stringify(r[2]))
	}
	for _, r := range rows(fx, "streamErr") {
		tl.add("classifyStreamError", classifiedObj(server.ClassifyStreamError(r[0].(string), r[1].(string))) == u.Stringify(r[2]))
	}
	for _, r := range rows(fx, "burst") {
		tl.add("isBurst", server.IsBurst(numPtr(r[0]), numPtr(r[1]), numPtr(r[2])) == r[3].(bool))
	}
	for _, r := range rows(fx, "sealed") {
		w := r[0].(string)
		tl.add("hasSealedReasoning", server.HasSealedReasoning(w, r[1]) == r[2].(bool))
		got := u.Stringify(server.StripSealedReasoning(w, reclone(r[1])))
		if got != u.Stringify(r[3]) {
			t.Logf("strip %s: got %s want %s", u.Stringify(r[1]), got, u.Stringify(r[3]))
		}
		tl.add("stripSealedReasoning", got == u.Stringify(r[3]))
	}
	for _, r := range rows(fx, "rejections") {
		tl.add("isReasoningRejection", server.IsReasoningRejection(int(r[0].(float64)), r[1].(string)) == r[2].(bool))
	}
	for _, r := range rows(fx, "sk") {
		h := http.Header{}
		ho := r[1].(*u.Obj)
		for _, k := range ho.Keys() {
			h[k] = []string{ho.Get(k).(string)}
		}
		got := server.SessionKey(r[0].(string), h, r[2], r[3].(string), r[4].(bool))
		want, _ := r[5].(string)
		if got != want {
			t.Logf("sessionKey %s: got %q want %q", u.Stringify(r[:5]), got, want)
		}
		tl.add("sessionKey", got == want)
	}
	tl.report(t, "helpers")
}

func reclone(v any) any {
	if v == nil {
		return nil
	}
	c, _ := u.ParseString(u.Stringify(v))
	return c
}

func TestParityMetrics(t *testing.T) {
	fx := loadJSFixture(t, "helpers")
	tl := tally{}
	for _, mc := range fx.Get("metrics").([]any) {
		mo := mc.(*u.Obj)
		var clock float64 = 1000
		opts := server.MetricsOptions{Now: func() float64 { return clock }}
		if mo.Get("ci").(float64) == 1 {
			c, h, r, ms, ws := 5, 3, 4, 3, 4
			opts.CrossCap, opts.HealthCap, opts.ReservoirSize = &c, &h, &r
			opts.Adaptive = server.AdaptiveOpts{MinSamples: &ms, WindowSize: &ws}
		}
		m := server.NewGatewayMetrics(opts)
		for i, op := range mo.Get("ops").([]any) {
			o := op.(*u.Obj)
			clock = o.Get("now").(float64)
			e := o.Get("e").(*u.Obj)
			s := func(k string) string { v, _ := e.Get(k).(string); return v }
			var losses []string
			if arr, ok := e.Get("losses").([]any); ok {
				for _, l := range arr {
					losses = append(losses, l.(string))
				}
			}
			m.Observe(server.MetricsObserve{Client: s("client"), Ingress: s("ingress"), Upstream: s("upstream"), UpstreamWire: s("upstreamWire"),
				RouteQuality: s("routeQuality"), Losses: losses, E2eMs: numPtr(e.Get("e2eMs")), TtftMs: numPtr(e.Get("ttftMs")),
				Provider: s("provider"), KeyID: s("keyId"), Outcome: s("outcome")})
			if snap, ok := o.Get("snap").(string); ok {
				got := u.Stringify(m.Snapshot())
				if got != snap {
					t.Logf("snapshot %d: got %s\nwant %s", i, got, snap)
				}
				tl.add("snapshot", got == snap)
			}
			if hs, ok := o.Get("hints").([]any); ok {
				args := [][3]string{{"p1", "k1", "messages"}, {"p2", "k2", "chat"}, {"p3", "k1", "chat"}, {"p1", "k1", "responses"}}
				for j, h := range hs {
					got := u.Stringify(m.DemoteHint(args[j][0], args[j][1], args[j][2]).Obj())
					if got != h.(string) {
						t.Logf("hint %d/%d: got %s want %s", i, j, got, h)
					}
					tl.add("demoteHint", got == h.(string))
				}
			}
		}
	}
	tl.report(t, "metrics")
}
