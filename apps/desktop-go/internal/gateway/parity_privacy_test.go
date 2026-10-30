package gateway_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/privacy"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func spansJSON(sp []privacy.SecretSpan) string {
	a := make([]any, 0, len(sp))
	for _, s := range sp {
		a = append(a, s.Obj())
	}
	return u.Stringify(a)
}

func hitsJSON(hs []*privacy.RedactionHit) string {
	a := make([]any, 0, len(hs))
	for _, h := range hs {
		a = append(a, h.Obj())
	}
	return u.Stringify(a)
}

func restoreJSON(r *privacy.Restore) string {
	a := make([]any, 0)
	for _, k := range r.Keys() {
		v, _ := r.Get(k)
		a = append(a, []any{k, v})
	}
	return u.Stringify(a)
}

func spansOf(v any) []privacy.SecretSpan {
	var out []privacy.SecretSpan
	for _, x := range v.([]any) {
		o := x.(*u.Obj)
		out = append(out, privacy.SecretSpan{Start: int(o.Get("start").(float64)), End: int(o.Get("end").(float64)), Kind: o.Get("kind").(string), By: o.Get("by").(string)})
	}
	return out
}

func entriesOf(v any) []privacy.Entry {
	var out []privacy.Entry
	for _, x := range v.([]any) {
		o := x.(*u.Obj)
		out = append(out, privacy.Entry{Kind: o.Get("kind").(string), Value: o.Get("value").(string)})
	}
	return out
}

func check(t *testing.T, tl tally, name string, got, want any, ctx ...any) {
	t.Helper()
	g, w := u.Stringify(got), u.Stringify(want)
	if g != w {
		t.Logf("%s %v:\n got  %s\n want %s", name, ctx, g, w)
	}
	tl.add(name, g == w)
}

func TestParityPrivacy(t *testing.T) {
	fx := loadJSFixture(t, "privacy")
	tl := tally{}
	check(t, tl, "version", float64(privacy.RulesVersion), fx.Get("version"))
	for i, r := range fx.Get("rules").([]any) {
		a := r.([]any)
		s := a[0].(string)
		check(t, tl, "ruleSpans", spansJSON(privacy.RuleSpans(s, false)), a[1], i)
		check(t, tl, "ruleSpans.strict", spansJSON(privacy.RuleSpans(s, true)), a[2], i)
		check(t, tl, "entropy", privacy.Entropy(s), a[3], i)
		check(t, tl, "hasSecret", privacy.HasSecret(s, false), a[4], i)
	}
	for i, r := range fx.Get("merge").([]any) {
		a := r.([]any)
		check(t, tl, "mergeSpans", spansJSON(privacy.MergeSpans(spansOf(a[0]))), a[1], i)
	}
	for i, r := range fx.Get("ph").([]any) {
		a := r.([]any)
		key, kind, v := a[0].(string), a[1].(string), a[2].(string)
		tag := privacy.TagOf(key, kind, v)
		check(t, tl, "tagOf", tag, a[3], i)
		check(t, tl, "placeholderOf", privacy.PlaceholderOf(kind, tag, int(a[5].(float64))), a[4], i)
		check(t, tl, "allowTagOf", privacy.AllowTagOf(key, v), a[6], i)
		var sh any
		if s, ok := privacy.ShapeOf(key, kind, v); ok {
			sh = s
		}
		check(t, tl, "shapeOf", sh, a[7], i)
	}
	for sc, x := range fx.Get("store").([]any) {
		o := x.(*u.Obj)
		var st *privacy.SecretStore
		if m, ok := o.Get("max").(float64); ok {
			st = privacy.NewSecretStore(int(m))
		} else {
			st = privacy.NewSecretStore()
		}
		for i, op := range o.Get("ops").([]any) {
			a := op.([]any)
			ctx := []any{sc, i}
			switch a[0].(string) {
			case "setKey":
				st.SetKey(a[1].(string))
			case "setShape":
				st.SetShape(a[1].(bool))
			case "setKnown":
				st.SetKnown(entriesOf(a[1]))
			case "clear":
				st.Clear()
			case "assign":
				check(t, tl, "store.assign", st.Assign(a[1].(string), a[2].(string)), a[3], ctx...)
			case "valueOf":
				var got any
				if v, ok := st.ValueOf(a[1].(string)); ok {
					got = v
				}
				check(t, tl, "store.valueOf", got, a[2], ctx...)
			case "find":
				check(t, tl, "store.find", spansJSON(st.Find(a[1].(string))), a[2], ctx...)
			}
			check(t, tl, "store.size", float64(st.Size()), a[len(a)-1], ctx...)
		}
	}
	for sc, x := range fx.Get("mask").([]any) {
		m := x.(*u.Obj)
		key := m.Get("key").(string)
		st := privacy.NewSecretStore()
		st.SetKey(key)
		st.SetShape(m.Get("shape").(bool))
		st.SetKnown(entriesOf(m.Get("known")))
		for i, op := range m.Get("ops").([]any) {
			o := op.(*u.Obj)
			ctx := []any{sc, i}
			jo := o.Get("opts").(*u.Obj)
			opts := privacy.MaskOptions{Key: key}
			if b, _ := jo.Get("strict").(bool); b {
				opts.Strict = true
			}
			if ac, ok := jo.Get("actions").(*u.Obj); ok {
				opts.Actions = map[string]string{}
				for _, k := range ac.Keys() {
					opts.Actions[k] = ac.Get(k).(string)
				}
			}
			if al, ok := o.Get("allow").([]any); ok {
				opts.Allow = map[string]bool{}
				for _, a := range al {
					opts.Allow[a.(string)] = true
				}
			}
			withText := o.Get("text").(bool)
			in, err := u.ParseString(o.Get("input").(string))
			if err != nil {
				t.Fatal(err)
			}
			var r privacy.MaskResult
			var out string
			if withText {
				r = privacy.MaskText(in.(string), st, opts)
				out = r.Text
			} else {
				r = privacy.MaskBody(in, st, opts)
				out = u.Stringify(r.Body)
			}
			check(t, tl, "mask.out", out, o.Get("out"), ctx...)
			check(t, tl, "mask.hits", hitsJSON(r.Hits), o.Get("hits"), ctx...)
			check(t, tl, "mask.restore", restoreJSON(r.Restore), u.Stringify(o.Get("restore")), ctx...)
			check(t, tl, "mask.blocked", r.Blocked, o.Get("blocked"), ctx...)
			rs := privacy.NewRestorer(r.Restore)
			pushed := make([]any, 0)
			for _, c := range o.Get("chunks").([]any) {
				pushed = append(pushed, rs.Push(c.(string)))
			}
			check(t, tl, "restorer.push", pushed, o.Get("pushed"), ctx...)
			check(t, tl, "restorer.end", rs.End(), o.Get("end"), ctx...)
			check(t, tl, "restorer.raw", rs.Raw(out), o.Get("rawBack"), ctx...)
			var jv any = r.Body
			if withText {
				jv = r.Text
			}
			check(t, tl, "restorer.json", u.Stringify(rs.JSON(jv)), o.Get("jsonBack"), ctx...)
			check(t, tl, "restorer.text", rs.Text(out, o.Get("escaped").(bool)), o.Get("textBack"), ctx...)
			ks, cs := rs.Counts()
			counts := make([]any, 0)
			for _, k := range ks {
				counts = append(counts, []any{k, float64(cs[k])})
			}
			check(t, tl, "restorer.counts", counts, o.Get("counts"), ctx...)
		}
	}
	for i, x := range fx.Get("preview").([]any) {
		a := x.([]any)
		po := a[1].(*u.Obj)
		p := &config.PrivacyConfig{Key: po.Get("key").(string)}
		p.Strict, _ = po.Get("strict").(bool)
		p.Shape, _ = po.Get("shape").(bool)
		if ac, ok := po.Get("actions").(*u.Obj); ok {
			p.Actions = map[string]string{}
			for _, k := range ac.Keys() {
				p.Actions[k] = ac.Get(k).(string)
			}
		}
		al0, _ := po.Get("allow").([]any)
		for _, al := range al0 {
			p.Allow = append(p.Allow, al.(string))
		}
		if kn, ok := po.Get("known").([]any); ok {
			for _, e := range entriesOf(kn) {
				p.Known = append(p.Known, config.KnownSecret{Kind: e.Kind, Value: e.Value})
			}
		}
		text, hits := privacy.PreviewPrivacy(a[0].(string), p)
		check(t, tl, "preview.text", text, a[2], i)
		check(t, tl, "preview.hits", hitsJSON(hits), a[3], i)
	}
	tl.report(t, "privacy")
}
