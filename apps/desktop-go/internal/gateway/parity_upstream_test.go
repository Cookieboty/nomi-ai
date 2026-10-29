package gateway_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/toolnames"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type upFx struct {
	Providers []config.RuntimeProvider         `json:"providers"`
	Clients   map[string]*config.ClientRuntime `json:"clients"`
	Bodies    map[string][]json.RawMessage     `json:"bodies"`
	Chs       []map[string]any                 `json:"chs"`
	Cases     []struct {
		Req   []*string `json:"req"`
		Err   *string   `json:"err"`
		Cands []struct {
			P, K, Pm, Um, W string
		} `json:"cands"`
		Per []struct {
			C, M     int
			URL      []string          `json:"url"`
			Headers  []json.RawMessage `json:"headers"`
			Official json.RawMessage   `json:"official"`
			Bodies   []struct {
				B      int
				Stream bool
				Be     *string
				Body   *string
				Error  *string
				Notes  []string
			} `json:"bodies"`
			Tl []*string         `json:"tl"`
			Rf []json.RawMessage `json:"rf"`
		} `json:"per"`
	} `json:"cases"`
	ToolCount []struct {
		W string
		B json.RawMessage
		N int
	} `json:"toolCount"`
	Ct []struct {
		B     json.RawMessage
		Names []string
		Same  bool
		R     *string
	} `json:"ct"`
	Refusal []struct {
		St float64
		T  string
		S  int
		R  bool
	} `json:"refusal"`
	Ingress []struct {
		P string
		R json.RawMessage
	} `json:"ingress"`
	Gpath    []struct{ M, R string } `json:"gpath"`
	Envs     []map[string]string     `json:"envs"`
	Hooks    []map[string]float64    `json:"hooks"`
	Timeouts []struct {
		E, H          int
		S, R          bool
		Fb, Bud, Idle float64
	} `json:"timeouts"`
	Now        float64 `json:"now"`
	RetryAfter []struct {
		V *string
		R *float64
	} `json:"retryAfter"`
	CoolsDown []struct {
		F struct {
			Network        bool     `json:"network"`
			UpstreamStatus *float64 `json:"upstreamStatus"`
		}
		R bool
	} `json:"coolsDown"`
	CdScript [][]json.RawMessage `json:"cdScript"`
	CdOut    []struct {
		R  json.RawMessage
		Ev json.RawMessage
	} `json:"cdOut"`
	LimitsOf []struct {
		P string
		K config.RuntimeKey
		R struct {
			MaxConcurrency float64 `json:"maxConcurrency"`
			Rpm            float64 `json:"rpm"`
		}
	} `json:"limitsOf"`
}

func pv(b json.RawMessage) any {
	v, err := u.Parse(b)
	if err != nil {
		panic(err)
	}
	return v
}

func js(v any) string { return u.Stringify(v) }

func TestParityUpstream(t *testing.T) {
	var fx upFx
	loadFixture(t, "upstream", &fx)
	tl := tally{}
	chk := func(sec string, ok bool, args ...any) {
		tl.add(sec, ok)
		if !ok && tl[sec][1] <= 5 {
			t.Log(append([]any{sec + ":"}, args...)...)
		}
	}
	cfg := &config.GatewayConfig{Host: "127.0.0.1", Port: 1, Providers: fx.Providers, Clients: fx.Clients, Learned: map[string]*config.LearnedState{}}
	muts := []func(c *cand.Candidate){
		func(c *cand.Candidate) {},
		func(c *cand.Candidate) { c.Rectify = []string{"budget", "effort"} },
		func(c *cand.Candidate) { c.CustomToolsAsFunctions = true },
		func(c *cand.Candidate) { c.DropParams = []string{"temperature", "tools"} },
	}
	for _, cs := range fx.Cases {
		client, model, ingress := ns(cs.Req[0]), *cs.Req[1], *cs.Req[2]
		r := route.ResolveCandidates(cfg, client, model, ingress, nil)
		if cs.Err != nil {
			chk("resolve", !r.OK && r.Message == *cs.Err)
			continue
		}
		if !r.OK || len(r.Candidates) < len(cs.Cands) {
			chk("resolve", false, cs.Req)
			continue
		}
		bodies := fx.Bodies[ingress]
		for _, e := range cs.Per {
			c := r.Candidates[e.C].Clone()
			muts[e.M](c)
			want := cs.Cands[e.C]
			chk("cand", c.Provider.ID == want.P && c.Key.ID == want.K && c.PublicModel == want.Pm && c.UpstreamModel == want.Um && c.Wire == want.W, cs.Req, e.C)
			base := ""
			if s, ok := c.Provider.URLs.Get(c.Wire).(string); ok {
				base = s
			}
			got := []string{upstream.URL(c.Wire, base, c.UpstreamModel, upstream.URLOpts{}), upstream.URL(c.Wire, base, c.UpstreamModel, upstream.URLOpts{Stream: true}), upstream.URL(c.Wire, base, c.UpstreamModel, upstream.URLOpts{CountTokens: true})}
			chk("url", eqStrs(got, e.URL), got, e.URL)
			hi := 0
			for _, ch := range fx.Chs {
				for _, st := range []bool{false, true} {
					h := upstream.Headers(c, upstream.HeaderOpts{Stream: st, ClientHeaders: ch, SameWire: ingress == c.Wire})
					pairs := []any{}
					for _, k := range h.Keys() {
						pairs = append(pairs, []any{k, h.Get(k)})
					}
					chk("headers", canonJSON(js(pairs)) == canonJSON(string(e.Headers[hi])), js(pairs), string(e.Headers[hi]))
					hi++
				}
			}
			var cm any
			if m := upstream.CandidateModel(c); m != nil {
				cm = m.ID
			}
			off := js([]any{upstream.IsAnthropicOfficial(c), upstream.IsOpenAIOfficial(c), cm, upstream.CandidateIsReasoning(c)})
			chk("official", canonJSON(off) == canonJSON(string(e.Official)), off, string(e.Official))
			for _, bc := range e.Bodies {
				notes := []string{}
				var be *string
				if bc.Be != nil {
					be = bc.Be
				}
				out, err := upstream.Body(ingress, c, pv(bodies[bc.B]), upstream.BodyOpts{Stream: bc.Stream, IngressModel: u.Ptr("in-model"), Notes: &notes, Client: client, BindingEffort: be})
				if bc.Error != nil {
					chk("body", err != nil && err.Error() == *bc.Error, err, *bc.Error)
					continue
				}
				ok := err == nil && bc.Body != nil && canonJSON(js(out)) == canonJSON(*bc.Body) && eqStrs(notes, bc.Notes)
				chk("body", ok, cs.Req, e.C, e.M, bc.B, bc.Stream, ns(bc.Be), "\n got", js(out), notes, err, "\nwant", ns(bc.Body), bc.Notes)
			}
			for bi, b := range bodies {
				g := upstream.ToolLimitError(c, pv(b))
				w := ""
				if e.Tl[bi] != nil {
					w = *e.Tl[bi]
				}
				chk("toolLimit", g == w, g, w)
				o := upstream.ResponseFixOptions(ingress, c, pv(b), nil)
				var tn, tt any
				if o.ToolNames != nil {
					arr := []any{}
					for _, k := range orderedReverse(ingress, pv(b), o.ToolNames) {
						arr = append(arr, k)
					}
					tn = arr
				}
				if o.TextTools != nil {
					arr := []any{}
					for _, n := range textToolOrder(ingress, pv(b), o.TextTools) {
						arr = append(arr, n)
					}
					tt = arr
				}
				rj := js(u.NewObj("chatStream", *o.ChatStream, "toolNames", tn, "textTools", tt, "repetition", o.Repetition, "seed", o.CallIds.Seed))
				chk("responseFix", canonJSON(rj) == canonJSON(string(e.Rf[bi])), rj, string(e.Rf[bi]))
			}
		}
	}
	for _, c := range fx.ToolCount {
		chk("toolCount", upstream.ToolCount(c.W, pv(c.B)) == c.N, c.W, string(c.B))
	}
	for _, c := range fx.Ct {
		b := pv(c.B)
		r := upstream.CustomToolsToFunctions(b)
		names := upstream.CustomToolNames(b)
		ok := eqStrs(names, c.Names) && sameRef(r, b) == c.Same && c.R != nil && canonJSON(js(r)) == canonJSON(*c.R)
		chk("customTools", ok, string(c.B), js(r))
	}
	sent := fx.Bodies["responses"][1]
	for _, c := range fx.Refusal {
		var s any
		switch c.S {
		case 0:
			s = u.NewObj()
		case 1:
			s = pv(sent)
		}
		chk("refusal", upstream.IsCustomToolRefusal(c.St, c.T, s, c.S >= 0) == c.R, c.St, c.T, c.S)
	}
	for _, c := range fx.Ingress {
		g := js(upstream.IngressFromPath(c.P).JSON())
		chk("ingress", canonJSON(g) == canonJSON(string(c.R)), c.P, g, string(c.R))
	}
	for _, c := range fx.Gpath {
		g := upstream.GeminiModelPath(c.M)
		chk("geminiPath", g == c.R, c.M, g, c.R)
	}
	names := map[string]bool{}
	for _, e := range fx.Envs {
		for k := range e {
			names[k] = true
		}
	}
	for _, c := range fx.Timeouts {
		for k := range names {
			os.Unsetenv(k)
		}
		for k, v := range fx.Envs[c.E] {
			os.Setenv(k, v)
		}
		h := hooksOf(fx.Hooks[c.H])
		fb, bud, idle := upstream.ResolveFirstByteTimeoutMs(c.S, c.R, h), upstream.ResolveFirstByteBudgetMs(c.S, h), upstream.ResolveStreamIdleTimeoutMs(h)
		chk("timeouts", fb == c.Fb && bud == c.Bud && idle == c.Idle, c.E, c.H, c.S, c.R, fb, bud, idle, c.Fb, c.Bud, c.Idle)
	}
	for k := range names {
		os.Unsetenv(k)
	}
	for _, c := range fx.RetryAfter {
		g := upstream.ParseRetryAfter(c.V, fx.Now)
		ok := (g == nil) == (c.R == nil) && (g == nil || *g == *c.R)
		chk("retryAfter", ok, ns(c.V), g, c.R)
	}
	for _, c := range fx.CoolsDown {
		chk("coolsDown", upstream.CoolsDown(c.F.Network, c.F.UpstreamStatus) == c.R)
	}
	now := fx.Now
	evs := []any{}
	cool := upstream.NewCooldowns(func(e upstream.KeyStatusEvent) { evs = append(evs, e.JSON()) }, func() float64 { return now })
	pa := &config.RuntimeProvider{ID: "p"}
	ka := &config.RuntimeKey{ID: "k"}
	cds := []*cand.Candidate{{Provider: pa, Key: ka, Wire: "chat"}, {Provider: pa, Key: ka, Wire: "messages"}}
	for i, st := range fx.CdScript {
		var op string
		var idx float64
		json.Unmarshal(st[0], &op)
		json.Unmarshal(st[1], &idx)
		c := cds[0]
		if idx == 1 {
			c = cds[1]
		}
		var r any
		switch op {
		case "fail":
			var f struct {
				UpstreamStatus *float64 `json:"upstreamStatus"`
				RetryAfter     *string  `json:"retryAfter"`
				Message        *string  `json:"message"`
			}
			json.Unmarshal(st[2], &f)
			r = cool.Fail(c, upstream.Failure{UpstreamStatus: f.UpstreamStatus, RetryAfter: f.RetryAfter, Message: f.Message})
		case "is":
			r = cool.IsCooling(c)
		case "until":
			if p := cool.CoolingUntil(c); p != nil {
				r = *p
			}
		case "success":
			cool.Success(c)
		case "adv":
			now += idx
		}
		got := js(u.NewObj("r", r, "ev", evs))
		evs = []any{}
		want := js(u.NewObj("r", pv(fx.CdOut[i].R), "ev", pv(fx.CdOut[i].Ev)))
		chk("cooldown", canonJSON(got) == canonJSON(want), i, got, want)
	}
	prov := map[string]*config.RuntimeProvider{}
	for i := range cfg.Providers {
		prov[cfg.Providers[i].ID] = &cfg.Providers[i]
	}
	for _, c := range fx.LimitsOf {
		k := c.K
		l := upstream.LimitsOf(prov[c.P], &k)
		chk("limitsOf", l.MaxConcurrency == c.R.MaxConcurrency && l.RPM == c.R.Rpm, c.P, k.ID, l, c.R)
	}
	tl.report(t, "upstream")
	for k, v := range tl {
		if v[1] > 0 {
			t.Errorf("%s: %d failures", k, v[1])
		}
	}
}

func sameRef(a, b any) bool {
	ao, ok1 := a.(*u.Obj)
	bo, ok2 := b.(*u.Obj)
	if ok1 && ok2 {
		return ao == bo
	}
	if ok1 || ok2 {
		return false
	}
	return js(a) == js(b)
}

func hooksOf(m map[string]float64) upstream.TimeoutHooks {
	p := func(k string) *float64 {
		if v, ok := m[k]; ok {
			return &v
		}
		return nil
	}
	return upstream.TimeoutHooks{FirstByteTimeoutMs: p("firstByteTimeoutMs"), NonStreamFirstByteTimeoutMs: p("nonStreamFirstByteTimeoutMs"),
		ReasoningNonStreamFirstByteTimeoutMs: p("reasoningNonStreamFirstByteTimeoutMs"), FirstByteBudgetMs: p("firstByteBudgetMs"),
		NonStreamFirstByteBudgetMs: p("nonStreamFirstByteBudgetMs"), StreamIdleTimeoutMs: p("streamIdleTimeoutMs")}
}

// sortedPairs is `[...map]` in insertion order (rebuilt from the tool name order).
func orderedReverse(ingress string, body any, m map[string]string) []any {
	out := []any{}
	seen := map[string]bool{}
	for _, n := range toolnames.IngressToolNames(ingress, body) {
		k := toolnames.ChatToolName(n)
		if v, ok := m[k]; ok && !seen[k] {
			seen[k] = true
			out = append(out, []any{k, v})
		}
	}
	return out
}

func textToolOrder(ingress string, body any, set map[string]bool) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, n := range toolnames.IngressToolNames(ingress, body) {
		if set[n] && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}
