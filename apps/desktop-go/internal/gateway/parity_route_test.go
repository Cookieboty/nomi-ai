package gateway_test

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type routeFx struct {
	Providers []config.RuntimeProvider           `json:"providers"`
	Learned   map[string]*config.LearnedState    `json:"learned"`
	Clients   map[string]*config.ClientRuntime   `json:"clients"`
	Cfgs      []struct {
		RoutePlan    *string `json:"routePlan"`
		StrictParams *bool   `json:"strictParams"`
	} `json:"cfgs"`
	Bare []struct {
		M              string
		Claude, Openai bool
	} `json:"bare"`
	Wires []struct {
		P, Model string
		Key      int
		Now      float64
		Wires    []string
	} `json:"wires"`
	Pick []struct {
		P, Model string
		Ingress  *string
		Usable   []string
		Wire     *string
	} `json:"pick"`
	Plan []struct {
		P, Model string
		Ingress  *string
		Usable   []string
		Plan     json.RawMessage
		NoModel  json.RawMessage
	} `json:"plan"`
	Effs   []json.RawMessage `json:"effs"`
	Losses []struct {
		E    int
		A    *string
		B    string
		L    []string
	} `json:"losses"`
	Quality []struct {
		L []string
		Q string
	} `json:"quality"`
	Sents     []json.RawMessage `json:"sents"`
	Rectifier []struct {
		St int
		T  string
		S  int
		R  *struct {
			Fix      string
			Rejected string
		}
	} `json:"rectifier"`
	SentEffort []*string `json:"sentEffort"`
	Lower      []*string `json:"lower"`
	Remaining  []struct {
		R   string
		K   []string
		Out []string
	} `json:"remaining"`
	Apply []struct {
		W     string
		S     int
		Fx    []string
		Mo    *float64
		Same  bool
		Body  *string
		Notes []string
	} `json:"apply"`
	ModelSets []*config.ClientModels `json:"modelSets"`
	MapModel  []struct {
		C   *string
		M   int
		R   string
		B   bool
		Out *struct{ Ref, How, Note string }
	} `json:"mapModel"`
	Split []struct {
		R, Model string
		Provider *string
	} `json:"split"`
	ModelJSON []string `json:"modelJSON"`
	Resolve   []struct {
		Cfg  int
		C    *string
		N    string
		Ing  *string
		B    int
		R    json.RawMessage
	} `json:"resolve"`
	Bindings []*struct {
		Models *config.ClientModels `json:"models"`
	} `json:"bindings"`
	Alt []struct {
		Cfg int
		N   string
		I   int
		Ex  []string
		Ing string
		A   json.RawMessage
	} `json:"alt"`
	Preferred []struct {
		Cfg  int
		C, N string
		P    json.RawMessage
	} `json:"preferred"`
	Tokens []struct {
		T  string
		OK bool
		H  string
	} `json:"tokens"`
	Binding []struct {
		M    json.RawMessage
		Ack  json.RawMessage
		Size int
		A, B json.RawMessage
	} `json:"binding"`
	Lookup []struct {
		Tok string
		B   json.RawMessage
	} `json:"lookup"`
}

func ns(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func eqStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func planJSON(p *cand.RoutePlan) string {
	if p == nil {
		return "null"
	}
	return u.Stringify(p.JSON())
}

func TestParityRoute(t *testing.T) {
	var fx routeFx
	loadFixture(t, "route", &fx)
	tl := tally{}
	prov := map[string]*config.RuntimeProvider{}
	for i := range fx.Providers {
		prov[fx.Providers[i].ID] = &fx.Providers[i]
	}
	cfgs := make([]*config.GatewayConfig, len(fx.Cfgs))
	for i, c := range fx.Cfgs {
		cfgs[i] = &config.GatewayConfig{Host: "127.0.0.1", Port: 1, Providers: fx.Providers, Clients: fx.Clients, Learned: fx.Learned, RoutePlan: ns(c.RoutePlan), StrictParams: c.StrictParams != nil && *c.StrictParams}
	}
	fail := func(sec string, ok bool, args ...any) {
		tl.add(sec, ok)
		if !ok && tl[sec][1] <= 5 {
			t.Log(append([]any{sec + ":"}, args...)...)
		}
	}
	for _, c := range fx.Bare {
		fail("bare", route.IsClaudeModel(c.M) == c.Claude && route.IsOpenAIModel(c.M) == c.Openai, c.M)
	}
	for _, c := range fx.Wires {
		p := prov[c.P]
		var k *config.RuntimeKey
		if c.Key >= 0 {
			k = &p.Keys[c.Key]
		}
		got := route.WiresFor(p, c.Model, k, fx.Learned[c.P], c.Now)
		fail("wiresFor", eqStrs(got, c.Wires), c.P, c.Model, c.Key, got, c.Wires)
	}
	for _, c := range fx.Pick {
		got := route.PickWire(prov[c.P], c.Model, ns(c.Ingress), c.Usable)
		fail("pickWire", got == ns(c.Wire), c.P, c.Model, ns(c.Ingress), c.Usable, got)
	}
	for _, c := range fx.Plan {
		p := prov[c.P]
		m := models.EffectiveModel(p, c.Model, fx.Learned[c.P], models.EffectiveOpts{})
		g1 := planJSON(route.MakePlan(p, m, ns(c.Ingress), c.Usable))
		g2 := planJSON(route.MakePlan(p, nil, ns(c.Ingress), c.Usable))
		fail("makePlan", canonJSON(g1) == canonJSON(string(c.Plan)) && canonJSON(g2) == canonJSON(string(c.NoModel)), c.P, c.Model, ns(c.Ingress), c.Usable, g1, string(c.Plan), g2, string(c.NoModel))
	}
	for _, c := range fx.Losses {
		e := u.AsObj(jobj(t, fx.Effs[c.E]))
		got := route.LossesOf(ns(c.A), c.B, e)
		fail("lossesOf", eqStrs(got, c.L), c.E, ns(c.A), c.B, got)
	}
	for _, c := range fx.Quality {
		fail("qualityOf", route.QualityOf(c.L) == c.Q, c.L)
	}
	sents := make([]any, len(fx.Sents))
	for i, s := range fx.Sents {
		sents[i] = jobj(t, s)
	}
	for _, c := range fx.Rectifier {
		r := route.RectifierFor(c.St, c.T, sents[c.S])
		ok := (r == nil) == (c.R == nil) && (r == nil || (r.Fix == c.R.Fix && r.Rejected == c.R.Rejected))
		fail("rectifierFor", ok, c.St, c.T, c.S, r)
	}
	for i, e := range fx.SentEffort {
		fail("sentEffort", route.SentEffort(sents[i]) == ns(e), i)
	}
	for i, e := range []string{"minimal", "low", "medium", "high", "xhigh", "max", "zz"} {
		fail("lowerEffort", route.LowerEffort(e) == ns(fx.Lower[i]), e)
	}
	for _, c := range fx.Remaining {
		fail("remainingEfforts", eqStrs(route.RemainingEfforts(c.R, c.K), c.Out), c.R, c.K)
	}
	for _, c := range fx.Apply {
		notes := []string{}
		r := route.ApplyRectifiers(c.W, sents[c.S], c.Fx, c.Mo, &notes)
		same := false
		if o, ok := sents[c.S].(*u.Obj); ok {
			ro, _ := r.(*u.Obj)
			same = ro == o
		} else {
			same = true // non-objects are returned as-is
		}
		got := stringify(r)
		fail("applyRectifiers", same == c.Same && sp(got) == sp(c.Body) && eqStrs(notes, c.Notes), c.W, c.S, c.Fx, c.Mo, sp(got), sp(c.Body), notes, c.Notes)
	}
	for _, c := range fx.MapModel {
		got := route.MapModel(ns(c.C), fx.ModelSets[c.M], c.R, c.B)
		ok := (got == nil) == (c.Out == nil) && (got == nil || *got == route.MappedModel(*c.Out))
		fail("mapModel", ok, ns(c.C), c.M, c.R, c.B, got, c.Out)
	}
	for _, c := range fx.Split {
		p, m := route.SplitRef(c.R)
		fail("splitRef", p == ns(c.Provider) && m == c.Model, c.R)
	}
	ser := func(c *cand.Candidate) *u.Obj {
		var drops, custom, model, rect any
		if c.DropParams != nil {
			drops = strs(c.DropParams)
		}
		if c.CustomToolsAsFunctions {
			custom = true
		}
		if c.Model != nil {
			idx := -1
			s := u.Stringify(c.Model)
			for i, x := range fx.ModelJSON {
				if x == s {
					idx = i
				}
			}
			model = float64(idx)
		}
		if c.Rectify != nil {
			rect = strs(c.Rectify)
		}
		var plan any
		if c.Plan != nil {
			plan = c.Plan.JSON()
		}
		return u.NewObj("provider", c.Provider.ID, "key", c.Key.ID, "publicModel", c.PublicModel, "upstreamModel", c.UpstreamModel, "wire", c.Wire,
			"dropParams", drops, "customToolsAsFunctions", custom, "model", model, "plan", plan, "rectify", rect)
	}
	serR := func(r *route.ResolveResult) string {
		if r.OK {
			cs := []any{}
			for _, c := range r.Candidates {
				cs = append(cs, ser(c))
			}
			return u.Stringify(u.NewObj("ok", true, "candidates", cs, "resolution", r.Resolution.JSON()))
		}
		o := u.NewObj("ok", false, "status", float64(r.Status), "message", r.Message)
		if r.Suggestions != nil {
			o.Set("suggestions", strs(r.Suggestions))
		}
		return u.Stringify(o)
	}
	for _, c := range fx.Resolve {
		var b *config.ClientModels
		if bb := fx.Bindings[c.B]; bb != nil {
			b = bb.Models
			if b == nil {
				b = &config.ClientModels{}
			}
		}
		got := serR(route.ResolveCandidates(cfgs[c.Cfg], ns(c.C), c.N, ns(c.Ing), b))
		fail("resolve", canonJSON(got) == canonJSON(string(c.R)), c.Cfg, ns(c.C), c.N, ns(c.Ing), c.B, firstDiff(canonJSON(got), canonJSON(string(c.R))))
	}
	for _, c := range fx.Alt {
		r := route.ResolveCandidates(cfgs[c.Cfg], "", c.N, "chat", nil)
		got := "null"
		if a := route.AlternateWire(cfgs[c.Cfg], r.Candidates[c.I], c.Ing, c.Ex); a != nil {
			got = u.Stringify(ser(a))
		}
		fail("alternateWire", canonJSON(got) == canonJSON(string(c.A)), c.Cfg, c.N, c.I, c.Ex, c.Ing, firstDiff(canonJSON(got), canonJSON(string(c.A))))
	}
	for _, c := range fx.Preferred {
		got := "null"
		if p := route.PreferredWire(cfgs[c.Cfg], c.C, c.N); p != nil {
			ups := []any{}
			for _, x := range p.Upstreams {
				ups = append(ups, u.NewObj("providerId", x.ProviderID, "name", x.Name, "url", x.URL))
			}
			got = u.Stringify(u.NewObj("wire", p.Wire, "publicModel", p.PublicModel, "upstreams", ups))
		}
		fail("preferredWire", canonJSON(got) == canonJSON(string(c.P)), c.Cfg, c.C, c.N, got, string(c.P))
	}
	for _, c := range fx.Tokens {
		fail("tabToken", route.IsTabToken(c.T) == c.OK && route.HashTabToken(c.T) == c.H, c.T)
	}
	bjson := func(b *route.TabBinding) string {
		if b == nil {
			return "null"
		}
		x, _ := json.Marshal(b)
		return canonJSON(string(x))
	}
	tab := route.NewBindingTable()
	for i, c := range fx.Binding {
		var raw struct {
			Type, ID, TokenHash string
			Binding             map[string]json.RawMessage
		}
		_ = json.Unmarshal(c.M, &raw)
		m := route.BindingMessage{Type: raw.Type, ID: raw.ID, TokenHash: raw.TokenHash}
		if raw.Binding != nil {
			b := &route.TabBinding{}
			for k, v := range raw.Binding {
				switch k {
				case "generation":
					if json.Unmarshal(v, &b.Generation) != nil {
						b.Generation = math.NaN() // not a number: Number.isInteger is false
					}
				case "models":
					_ = json.Unmarshal(v, &b.Models)
				default:
					one, _ := json.Marshal(map[string]json.RawMessage{k: v})
					_ = json.Unmarshal(one, b)
				}
			}
			m.Binding = b
		}
		ack := tab.Handle(m)
		ackJ, _ := json.Marshal(ack)
		hA, hB := fx.Tokens[0].H, fx.Tokens[1].H
		ok := canonJSON(string(ackJ)) == canonJSON(string(c.Ack)) && tab.Size() == c.Size &&
			bjson(tab.Get(hA)) == canonJSON(string(c.A)) && bjson(tab.Get(hB)) == canonJSON(string(c.B))
		fail("bindingTable", ok, i, string(ackJ), string(c.Ack), tab.Size(), c.Size, bjson(tab.Get(hA)), string(c.A))
	}
	for _, c := range fx.Lookup {
		fail("lookup", bjson(tab.Lookup(c.Tok, 0)) == canonJSON(string(c.B)), c.Tok)
	}
	tl.report(t, "route")
	for _, v := range tl {
		if v[1] > 0 {
			t.Fail()
		}
	}
}
