package gateway_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/clients"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/intent"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/request"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func specJSON(s *clients.Spec) string {
	if s == nil {
		return "null"
	}
	o := u.NewObj("id", s.ID, "strictness", s.Strictness)
	if s.ExtraRequired != nil {
		o.Set("extraRequired", s.ExtraRequired)
	}
	if s.AcceptSpec {
		o.Set("acceptedEvents", "spec")
	} else if s.AcceptedEvents != nil {
		o.Set("acceptedEvents", strs(s.AcceptedEvents))
	}
	if s.HelperModels != nil {
		o.Set("helperModels", strs(s.HelperModels))
	}
	if s.SubagentModels != nil {
		o.Set("subagentModels", strs(s.SubagentModels))
	}
	if s.BuiltinModels != nil {
		var bm []any
		for _, r := range s.BuiltinModels {
			bm = append(bm, u.NewObj("pattern", r.Pattern, "slot", r.Slot))
		}
		o.Set("builtinModels", bm)
	}
	o.Set("unknownToMain", s.UnknownToMain)
	if s.SessionKey != nil {
		o.Set("sessionKey", rulesJSON(s.SessionKey))
	}
	if s.Heartbeat != "" {
		o.Set("heartbeat", u.NewObj("kind", s.Heartbeat))
	}
	if s.Legacy != nil {
		l := u.NewObj()
		if s.Legacy.Ingress != "" {
			l.Set("ingress", s.Legacy.Ingress)
		}
		if s.Legacy.UserAgent != "" {
			l.Set("userAgent", s.Legacy.UserAgent)
		}
		o.Set("legacy", l)
	}
	if s.SynthesizedReasoning != nil {
		o.Set("synthesizedReasoning", strs(s.SynthesizedReasoning))
	}
	return u.Stringify(o)
}

func rulesJSON(rs []clients.SessionKeyRule) []any {
	out := []any{}
	for _, r := range rs {
		x := u.NewObj()
		if r.Header != "" {
			x.Set("header", r.Header)
		}
		if r.BodyPath != "" {
			x.Set("bodyPath", r.BodyPath)
		}
		if r.Parse != "" {
			x.Set("parse", r.Parse)
		}
		x.Set("prefix", r.Prefix)
		out = append(out, x)
	}
	return out
}

func sp(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func jobj(t *testing.T, raw json.RawMessage) any {
	v, err := u.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func intentFrom(v any) *intent.Intent {
	o, _ := v.(*u.Obj)
	if o == nil {
		return nil
	}
	in := &intent.Intent{Mode: u.JSString(o.Get("mode")), Source: u.JSString(o.Get("source"))}
	if e, ok := o.Get("effort").(string); ok {
		in.Effort = e
	}
	if b, ok := o.Get("budget").(float64); ok {
		in.Budget = &b
	}
	if b, ok := o.Get("includeThoughts").(bool); ok {
		in.IncludeThoughts = &b
	}
	return in
}

func stringify(v any) *string {
	s := u.Stringify(v)
	return &s
}

func eqNotes(a []string, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}

func TestParityRules(t *testing.T) {
	var fx struct {
		IDs       []string
		ExtraSpec struct {
			ID, Strictness string
			AcceptedEvents []string
			ExtraRequired  json.RawMessage
		}
		Specs           []struct{ ID, Spec, Rules string }
		SessionKeyRules []struct {
			ID    *string
			Rules string
		}
		Legacy []struct {
			Wire       *string
			UA, Client *string
		}
		Slot []struct {
			ID, Name string
			Hit      *struct{ Slot, How string }
		}
		ModelSets []config.ClientModels
		SlotModel []struct {
			Models int
			Slot   string
			Model  *string
			Set    bool
		}
		Streams []string
		Conform []struct {
			ID, Wire string
			Stream   int
			Needed   bool
			Output   string
			Notes    []string
		}
		IntentBodies map[string][]json.RawMessage
		ReadIntent   []struct {
			Wire   string
			Body   int
			Client *string
			Intent *string
		}
		Intents []json.RawMessage
		Binding []struct {
			Intent int
			Effort *string
			Out    *string
		}
		E2B []struct {
			Effort string
			Max    *float64
			Budget float64
		}
		B2E []struct {
			Budget float64
			Max    *float64
			Effort string
		}
		Models        []json.RawMessage
		Reqs          map[string][]json.RawMessage
		RenderIntents []json.RawMessage
		ModelRequest  []struct {
			Wire           string
			Body, Model    int
			Output         string
			Changes, Error *string
			Notes          []string
		}
		Render []struct {
			Wire                string
			Body, Model, Intent int
			Output, Sent        string
			Losses, Notes       []string
		}
		Fit []struct {
			Want    string
			Efforts []string
			Out     string
		}
		StrictEdge []struct {
			In      string   `json:"in"`
			Out     string   `json:"out"`
			Changed bool     `json:"changed"`
			Notes   []string `json:"notes"`
		} `json:"strictEdge"`
		Inline []struct {
			In     json.RawMessage
			Out    string
			Gemini bool
		}
		DropReasoning []struct {
			Wire  string
			In    json.RawMessage
			Out   string
			Notes []string
		}
	}
	loadFixture(t, "rules", &fx)
	var tl tally
	tl = tally{}
	ex := &clients.Spec{ID: fx.ExtraSpec.ID, Strictness: fx.ExtraSpec.Strictness, AcceptedEvents: fx.ExtraSpec.AcceptedEvents}
	ex.ExtraRequired, _ = jobj(t, fx.ExtraSpec.ExtraRequired).(*u.Obj)
	clients.RegisterClientSpec(ex, nil)

	tl.add("ids", reflect.DeepEqual(clients.RegisteredClientIDs(), fx.IDs))
	for _, c := range fx.Specs {
		if c.ID == fx.ExtraSpec.ID {
			continue // registered by the test itself
		}
		s := clients.ClientSpecOf(c.ID)
		ok := canonJSON(specJSON(s)) == canonJSON(c.Spec) && canonJSON(u.Stringify(rulesJSON(clients.SessionKeyRules(c.ID)))) == canonJSON(c.Rules)
		if !ok {
			t.Errorf("spec %s:\n go %s\n ts %s", c.ID, specJSON(s), c.Spec)
		}
		tl.add("spec", ok)
	}
	for _, c := range fx.SessionKeyRules {
		got := u.Stringify(rulesJSON(clients.SessionKeyRules(sp(c.ID))))
		tl.add("sessionKeyRules", canonJSON(got) == canonJSON(c.Rules))
	}
	for _, c := range fx.Legacy {
		got := clients.LegacyClientOf(sp(c.Wire), sp(c.UA))
		ok := got == sp(c.Client)
		if !ok {
			t.Errorf("legacy %v %q: go %q ts %v", sp(c.Wire), sp(c.UA), got, sp(c.Client))
		}
		tl.add("legacy", ok)
	}
	for _, c := range fx.Slot {
		got := clients.BuiltinSlot(clients.ClientSpecOf(c.ID), c.Name)
		ok := (got == nil) == (c.Hit == nil) && (got == nil || (got.Slot == c.Hit.Slot && got.How == c.Hit.How))
		if !ok {
			t.Errorf("slot %s %q: go %+v ts %+v", c.ID, c.Name, got, c.Hit)
		}
		tl.add("builtinSlot", ok)
	}
	for _, c := range fx.SlotModel {
		m := &fx.ModelSets[c.Models]
		got := clients.SlotModel(m, c.Slot)
		ok := (got == nil) == (c.Model == nil) && sp(got) == sp(c.Model) && clients.SlotIsSet(m, c.Slot) == c.Set
		if !ok {
			t.Errorf("slotModel %d %s: go %v/%v ts %v/%v", c.Models, c.Slot, sp(got), clients.SlotIsSet(m, c.Slot), sp(c.Model), c.Set)
		}
		tl.add("slotModel", ok)
	}
	for _, c := range fx.Conform {
		s := clients.ClientSpecOf(c.ID)
		notes := []string{}
		cf := clients.NewConformer(&clients.ConformContext{Spec: s, Wire: c.Wire, Notes: &notes})
		str := fx.Streams[c.Stream]
		out := ""
		for i := 0; i < len(str); i += 7 {
			out += cf.Push(str[i:min(i+7, len(str))])
		}
		out += cf.End()
		ok := out == c.Output && eqNotes(notes, c.Notes) && clients.ConformNeeded(s, clients.ClientHooksOf(c.ID)) == c.Needed
		if !ok {
			t.Errorf("conform %s %s %d:\n go %q %v\n ts %q %v", c.ID, c.Wire, c.Stream, out, notes, c.Output, c.Notes)
		}
		tl.add("conform", ok)
	}
	for _, c := range fx.ReadIntent {
		got := stringify(intent.ReadIntent(c.Wire, jobj(t, fx.IntentBodies[c.Wire][c.Body]), sp(c.Client)).JSON())
		ok := sp(got) == sp(c.Intent) && (got == nil) == (c.Intent == nil)
		if !ok {
			t.Errorf("readIntent %s %d %v: go %v ts %v", c.Wire, c.Body, sp(c.Client), sp(got), sp(c.Intent))
		}
		tl.add("readIntent", ok)
	}
	for _, c := range fx.Binding {
		in := intentFrom(jobj(t, fx.Intents[c.Intent]))
		r := intent.WithBindingEffort(in, c.Effort)
		got := stringify(r.JSON())
		ok := sp(got) == sp(c.Out)
		if r == in && c.Out != nil { // passthrough: TS returns the caller's object as-is
			ok = canonJSON(*got) == canonJSON(*c.Out)
		}
		if !ok {
			t.Errorf("binding %d %v: go %v ts %v", c.Intent, sp(c.Effort), sp(got), sp(c.Out))
		}
		tl.add("binding", ok)
	}
	for _, c := range fx.E2B {
		var mt float64
		if c.Max != nil {
			mt = *c.Max
		}
		tl.add("effortToBudget", intent.EffortToBudget(c.Effort, mt) == c.Budget)
	}
	for _, c := range fx.B2E {
		var mt float64
		if c.Max != nil {
			mt = *c.Max
		}
		tl.add("budgetToEffort", intent.BudgetToEffort(c.Budget, mt) == c.Effort)
	}
	for _, c := range fx.ModelRequest {
		o := jobj(t, fx.Reqs[c.Wire][c.Body]).(*u.Obj)
		m := jobj(t, fx.Models[c.Model]).(*u.Obj)
		notes := []string{}
		ch, err := request.ModelRequest(c.Wire, o, m, &notes)
		var gotCh, gotErr *string
		if err != nil {
			s := err.Error()
			gotErr = &s
		} else {
			s := u.Stringify(ch.JSON())
			gotCh = &s
		}
		ok := u.Stringify(o) == c.Output && sp(gotCh) == sp(c.Changes) && sp(gotErr) == sp(c.Error) && eqNotes(notes, c.Notes)
		if !ok {
			t.Errorf("modelRequest %s b%d m%d:\n go %s %v %v %v\n ts %s %v %v %v", c.Wire, c.Body, c.Model, u.Stringify(o), sp(gotCh), sp(gotErr), notes, c.Output, sp(c.Changes), sp(c.Error), c.Notes)
		}
		tl.add("modelRequest", ok)
	}
	for _, c := range fx.Render {
		b := jobj(t, fx.Reqs[c.Wire][c.Body])
		m := jobj(t, fx.Models[c.Model]).(*u.Obj)
		notes := []string{}
		r := request.RenderReasoning(c.Wire, b, intentFrom(jobj(t, fx.RenderIntents[c.Intent])), m, &notes)
		ok := u.Stringify(r.Body) == c.Output && r.Sent == c.Sent && eqNotes(r.Losses, c.Losses) && eqNotes(notes, c.Notes)
		if !ok {
			t.Errorf("render %s b%d m%d i%d:\n go %s %q %v %v\n ts %s %q %v %v", c.Wire, c.Body, c.Model, c.Intent, u.Stringify(r.Body), r.Sent, r.Losses, notes, c.Output, c.Sent, c.Losses, c.Notes)
		}
		tl.add("render", ok)
	}
	for _, c := range fx.Fit {
		tl.add("fitLevel", request.FitLevel(c.Want, c.Efforts) == c.Out)
	}
	for _, c := range fx.Inline {
		in := jobj(t, c.In)
		got := u.Stringify(request.InlineRefs(in))
		ok := got == c.Out && request.GeminiExpressible(in) == c.Gemini
		if !ok {
			t.Errorf("inline %s: go %s ts %s", c.In, got, c.Out)
		}
		tl.add("inlineRefs", ok)
	}
	for _, c := range fx.StrictEdge {
		o := u.NewObj("tools", []any{u.NewObj("type", "function", "function", u.NewObj("name", "f", "parameters", jobj(t, json.RawMessage(c.In)), "strict", true))})
		notes := []string{}
		ch := request.CleanSchemas("chat", o, u.NewObj("tools", u.NewObj("schema", "openai-strict")), &notes)
		ok := u.Stringify(o) == c.Out && ch == c.Changed && eqNotes(notes, c.Notes)
		if !ok {
			t.Errorf("strictEdge %s:\n go %s\n ts %s", c.In, u.Stringify(o), c.Out)
		}
		tl.add("strictEdge", ok)
	}
	for _, c := range fx.DropReasoning {
		o := jobj(t, c.In).(*u.Obj)
		notes := []string{}
		request.DropReasoning(o, c.Wire, &notes)
		tl.add("dropReasoning", u.Stringify(o) == c.Out && eqNotes(notes, c.Notes))
	}
	tl.report(t, "rules")
}
