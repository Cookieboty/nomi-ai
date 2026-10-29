package gateway_test

import (
	"encoding/json"
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/toolnames"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// canonJSON re-encodes JSON with sorted keys (quirks are a typed struct in Go:
// field order is not part of the contract, see deviations table).
func canonJSON(s string) string {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return "!" + s
	}
	b, _ := json.Marshal(v) // encoding/json sorts map keys
	return string(b)
}

func TestParityProviders(t *testing.T) {
	var fx struct {
		Providers []json.RawMessage
		Bodies    map[string][]json.RawMessage
		Specs     []struct {
			Provider string
			Wire     *string
			Spec     string
			Quirks   string
			Native   *string
		}
		Request []struct {
			Provider, Wire string
			Body           int
			Output         string
			Notes          []string
		}
		ServerTool []struct {
			Provider, Wire, Ingress string
			Body                    int
			Error                   *string
		}
		Stage []struct {
			Spec, Text     string
			Cut            int
			Needed         bool
			Outs           []string
			Alive, Changed int
		}
		ToolNames []struct {
			Name  string
			Legal bool
			Chat  string
		}
		Ingress []struct {
			Wire  string
			Body  int
			Names []string
		}
		ReverseInputs [][]string
		Reverse       [][][2]string
		Mapped        []struct {
			Output string
			Notes  []string
		}
		Beta []struct{ In, Out string }
	}
	loadFixture(t, "providers", &fx)
	tl := tally{}
	check := func(k, got, want, ctx string) {
		ok := got == want
		if !ok {
			t.Errorf("%s %s:\n got %s\nwant %s", k, ctx, got, want)
		}
		tl.add(k, ok)
	}
	provs := map[string]*config.RuntimeProvider{}
	for _, raw := range fx.Providers {
		var p config.RuntimeProvider
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		provs[p.ID] = &p
	}
	body := func(w string, i int) *u.Obj {
		v, err := u.Parse(fx.Bodies[w][i])
		if err != nil {
			t.Fatal(err)
		}
		return v.(*u.Obj)
	}
	mk := func(p *config.RuntimeProvider, w string) *cand.Candidate {
		return &cand.Candidate{Provider: p, Key: &p.Keys[0], PublicModel: p.ID + "/m", UpstreamModel: "m", Wire: w}
	}
	for _, c := range fx.Specs {
		p := provs[c.Provider]
		w := ""
		if c.Wire != nil {
			w = *c.Wire
		}
		ctx := c.Provider + "/" + w
		check("specOf", providers.SpecOf(p, w).ID, c.Spec, ctx)
		qb, _ := json.Marshal(providers.QuirksOf(p, w))
		check("quirksOf", canonJSON(string(qb)), canonJSON(c.Quirks), ctx)
		if w != "" {
			want := ""
			if c.Native != nil {
				want = *c.Native
			}
			check("nativeOf", providers.NativeOf(mk(p, w)), want, ctx)
		}
	}
	for _, c := range fx.Request {
		o := body(c.Wire, c.Body)
		notes := []string{}
		providers.ProviderRequest(mk(provs[c.Provider], c.Wire), o, &notes)
		ctx := c.Provider + "/" + c.Wire
		check("request", u.Stringify(o), c.Output, ctx)
		check("notes", u.Stringify(strs(notes)), u.Stringify(strs(c.Notes)), ctx)
	}
	for _, c := range fx.ServerTool {
		want := ""
		if c.Error != nil {
			want = *c.Error
		}
		got := providers.ServerToolError(mk(provs[c.Provider], c.Wire), c.Ingress, body(c.Ingress, c.Body))
		check("serverTool", got, want, c.Provider+"/"+c.Wire+"<"+c.Ingress)
	}
	for _, c := range fx.Stage {
		spec := providers.ProviderSpecByID(c.Spec)
		check("needed", u.Stringify(providers.StageNeeded(spec)), u.Stringify(c.Needed), c.Spec)
		s := providers.NewStage(spec, "responses")
		units := []rune(c.Text) // texts are BMP-only ASCII: rune index == UTF-16 index
		outs := []string{}
		for i := 0; i < len(units); i += c.Cut {
			j := i + c.Cut
			if j > len(units) || j < 0 {
				j = len(units)
			}
			outs = append(outs, s.Push(string(units[i:j])))
		}
		outs = append(outs, s.End())
		check("stage", u.Stringify(strs(outs)), u.Stringify(strs(c.Outs)), c.Spec)
		check("stageCount", u.Stringify([]any{float64(s.Alive), float64(s.Changed)}), u.Stringify([]any{float64(c.Alive), float64(c.Changed)}), c.Spec)
	}
	for _, c := range fx.ToolNames {
		check("legal", u.Stringify(toolnames.IsLegalChatToolName(c.Name)), u.Stringify(c.Legal), c.Name)
		check("chatName", toolnames.ChatToolName(c.Name), c.Chat, c.Name)
	}
	for _, c := range fx.Ingress {
		check("ingressNames", u.Stringify(strs(toolnames.IngressToolNames(c.Wire, body(c.Wire, c.Body)))), u.Stringify(strs(c.Names)), c.Wire)
	}
	for i, in := range fx.ReverseInputs {
		m := toolnames.ChatToolNameReverse(in)
		got := "null"
		if m != nil {
			got = canonPairs(m)
		}
		want := "null"
		if fx.Reverse[i] != nil {
			mm := map[string]string{}
			for _, p := range fx.Reverse[i] {
				mm[p[0]] = p[1]
			}
			want = canonPairs(mm)
		}
		check("reverse", got, want, "")
	}
	for i, c := range fx.Mapped {
		o := body("chat", i)
		notes := []string{}
		toolnames.MapChatToolNames(o, &notes)
		check("mapNames", u.Stringify(o), c.Output, "")
		check("mapNotes", u.Stringify(strs(notes)), u.Stringify(strs(c.Notes)), "")
	}
	for _, c := range fx.Beta {
		check("beta", providers.FilterAnthropicBeta(c.In), c.Out, c.In)
	}
	tl.report(t, "providers")
}

func canonPairs(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := []any{}
	for _, k := range keys {
		out = append(out, []any{k, m[k]})
	}
	return u.Stringify(out)
}
