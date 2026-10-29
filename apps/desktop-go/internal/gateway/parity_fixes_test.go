package gateway_test

import (
	"reflect"
	"testing"

	resp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func fixOpts(variant string) (*resp.FixOptions, *[]string) {
	notes := []string{}
	if variant == "noFixes" {
		return &resp.FixOptions{Notes: &notes}, &notes
	}
	seed := "seed1"
	o := &resp.FixOptions{
		ToolNames:  map[string]string{"mapped_weather": "get_weather"},
		TextTools:  map[string]bool{"get_weather": true, "read_file": true},
		Repetition: true,
		Notes:      &notes,
		CallIds:    resp.NewCallIds(&seed),
	}
	if variant == "noChatStream" {
		f := false
		o.ChatStream = &f
	}
	return o, &notes
}

func sameNotes(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}

func TestParityFixes(t *testing.T) {
	type jconv struct {
		Ok     bool
		Status float64
		Body   string
		Notes  []string
	}
	var fx struct {
		Cases []struct {
			Name, From, To, Input string
			InChunks              []string `json:"inChunks"`
			Out                   []string
			Stopped               bool
			Notes                 []string
		}
		Passthrough []struct {
			Name, Wire, Variant, Input string
			InChunks                   []string `json:"inChunks"`
			Out                        []string
			Stopped, Nil               bool
			Notes                      []string
		}
		Terminal []struct {
			Name, Wire, Input string
			Terminated        bool
		}
		Fail []struct{ Wire, Out string }
		Json []struct {
			Name, Input, Patched string
			Notes                []string
			Conv                 map[string]jconv
		}
	}
	loadFixture(t, "fixes", &fx)

	tl := tally{}
	for _, c := range fx.Cases {
		o, notes := fixOpts("default")
		conv := stream.CreateStreamConverter(c.From, c.To, stream.WithFixes(parityConv, o))
		var out []string
		for _, p := range c.InChunks {
			out = append(out, conv.Push(p))
			if conv.Stopped() {
				break
			}
		}
		out = append(out, conv.End())
		ok := cmpChunks(t, c.Name, "fixer", c.Out, out)
		if conv.Stopped() != c.Stopped || !sameNotes(c.Notes, *notes) {
			t.Errorf("%s: stopped/notes node=%v %v go=%v %v", c.Name, c.Stopped, c.Notes, conv.Stopped(), *notes)
			ok = false
		}
		tl.add("fixer "+c.From+"→"+c.To, ok)
	}
	tl.report(t, "fixer")

	tp := tally{}
	for _, c := range fx.Passthrough {
		o, notes := fixOpts(c.Variant)
		p := stream.CreatePassthrough(c.Wire, o)
		ok := true
		if p == nil || c.Nil {
			if (p == nil) != c.Nil {
				t.Errorf("%s: nil node=%v go=%v", c.Name, c.Nil, p == nil)
				ok = false
			}
		} else {
			var out []string
			for _, ch := range c.InChunks {
				out = append(out, p.Push(ch))
				if p.Stopped() {
					break
				}
			}
			out = append(out, p.End())
			ok = cmpChunks(t, c.Name, "passthrough", c.Out, out)
			if p.Stopped() != c.Stopped || !sameNotes(c.Notes, *notes) {
				t.Errorf("%s: stopped/notes node=%v %v go=%v %v", c.Name, c.Stopped, c.Notes, p.Stopped(), *notes)
				ok = false
			}
		}
		tp.add("passthrough "+c.Wire+"/"+c.Variant, ok)
	}
	tp.report(t, "passthrough")

	tt := tally{}
	for _, c := range fx.Terminal {
		w := stream.NewTerminalWatch(c.Wire)
		pieces := splitUnits7(c.Input)
		for _, p := range pieces {
			w.Push(p)
		}
		ok := w.Terminated() == c.Terminated
		if !ok {
			t.Errorf("%s: terminated node=%v go=%v", c.Name, c.Terminated, !c.Terminated)
		}
		tt.add("terminal "+c.Wire, ok)
	}
	tt.report(t, "terminal")

	for _, c := range fx.Fail {
		if a, g := normalize(c.Out), normalize(stream.PassthroughFail(c.Wire, "upstream reset")); a != g {
			t.Errorf("fail %s: %s", c.Wire, firstDiff(a, g))
		}
	}

	tj := tally{}
	for _, c := range fx.Json {
		o, notes := fixOpts("default")
		b, _ := u.ParseString(c.Input)
		ok := true
		if a, g := normalize(c.Patched), normalize(u.Stringify(stream.PatchChatJson(b, o))); a != g || !sameNotes(c.Notes, *notes) {
			t.Errorf("%s patched: %s notes node=%v go=%v", c.Name, firstDiff(a, g), c.Notes, *notes)
			ok = false
		}
		for to, want := range c.Conv {
			o2, n2 := fixOpts("default")
			b2, _ := u.ParseString(c.Input)
			r := stream.JsonToJson("chat", to, b2, stream.WithFixes(parityConv, o2))
			if a, g := normalize(want.Body), normalize(u.Stringify(r.Body)); a != g || r.OK != want.Ok || !sameNotes(want.Notes, *n2) {
				t.Errorf("%s →%s: %s notes node=%v go=%v", c.Name, to, firstDiff(a, g), want.Notes, *n2)
				ok = false
			}
		}
		tj.add("json", ok)
	}
	tj.report(t, "fixes-json")
}

// splitUnits7 mirrors record.mjs splitUnits(t, 7) (UTF-16 units, no split surrogates).
func splitUnits7(s string) []string {
	var out []string
	rs := []rune(s)
	start, units := 0, 0
	for i, r := range rs {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units >= 7 {
			out = append(out, string(rs[start:i]))
			start, units = i, 0
		}
		units += w
	}
	if start < len(rs) {
		out = append(out, string(rs[start:]))
	}
	return out
}
