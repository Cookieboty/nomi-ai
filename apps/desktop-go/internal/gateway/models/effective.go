package models

import (
	"math"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// LearnedTTLMs is LEARNED_TTL_MS.
const LearnedTTLMs = 7 * 24 * 60 * 60_000

// Merge is merge: object fields merge key by key, arrays and scalars replace.
func Merge(base, over *u.Obj) *u.Obj {
	if over == nil {
		return base
	}
	out := base.Clone()
	for _, k := range over.Keys() {
		v := over.Get(k)
		vo, vok := v.(*u.Obj)
		bo, bok := base.Get(k).(*u.Obj)
		if vok && vo != nil && bok && bo != nil {
			out.Set(k, bo.Clone().Assign(vo))
		} else {
			out.Set(k, v)
		}
	}
	return out
}

func num(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

func userData(m *config.RuntimeModel) (*u.Obj, []string) {
	data := u.NewObj()
	set := []string{}
	if m == nil {
		return data, set
	}
	ctx, mo := num(m.Ctx), num(m.MaxOutput)
	if ctx != 0 || mo != 0 {
		l := u.NewObj()
		if ctx != 0 {
			l.Set("context", ctx)
		}
		if mo != 0 {
			l.Set("maxOutput", mo)
		}
		data.Set("limits", l)
		if ctx != 0 {
			set = append(set, "limits.context")
		}
		if mo != 0 {
			set = append(set, "limits.maxOutput")
		}
	}
	if m.Vision != nil {
		data.Set("input", u.NewObj("images", *m.Vision))
		set = append(set, "input.images")
	}
	if m.ToolCalling != nil {
		data.Set("tools", u.NewObj("calling", *m.ToolCalling))
		set = append(set, "tools.calling")
	}
	if m.Reasoning != nil && !*m.Reasoning {
		data.Set("reasoning", u.NewObj("control", "none"))
		set = append(set, "reasoning")
	}
	if len(m.Efforts) > 0 {
		r, _ := data.Get("reasoning").(*u.Obj)
		if r == nil {
			r = u.NewObj("control", "effort")
		} else {
			r = r.Clone()
		}
		data.Set("reasoning", r.Set("efforts", strs(m.Efforts)))
		set = append(set, "reasoning.efforts")
	}
	return data, set
}

func strs(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// learnedData is learnedData; proto marks the inherited-property case
// (`learned.models[name]` hitting Object.prototype: at is undefined).
func learnedData(l *config.LearnedModel, proto bool, now float64) *u.Obj {
	if proto {
		return u.NewObj() // NaN > TTL is false; no version, no efforts
	}
	if l == nil || now-l.At > LearnedTTLMs {
		return nil
	}
	if l.CatalogVersion != "" && l.CatalogVersion != CatalogVersion {
		return nil
	}
	d := u.NewObj()
	if len(l.Efforts) > 0 {
		d.Set("reasoning", u.NewObj("control", "effort", "efforts", strs(l.Efforts)))
	}
	if l.Temperature != nil && !*l.Temperature {
		d.Set("sampling", u.NewObj("temperature", false))
	}
	return d
}

type effHit struct {
	learned *config.LearnedState
	until   float64
	e       *u.Obj
}

// EffectiveOpts is the opts argument (Strict nil = undefined, Now nil = Date.now()).
type EffectiveOpts struct {
	Strict *bool
	Now    *float64
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// EffectiveModel is effectiveModel. The result is shared (cached): callers
// must not modify it.
func EffectiveModel(p *config.RuntimeProvider, model string, learned *config.LearnedState, opts EffectiveOpts) *u.Obj {
	strictBit := "0"
	if opts.Strict != nil && *opts.Strict {
		strictBit = "1"
	}
	key := "eff:" + model + "\x00" + strictBit
	memo := p.Memo()
	now := nowMs()
	if opts.Now != nil {
		now = *opts.Now
	}
	if v, ok := memo.Load(key); ok {
		h := v.(*effHit)
		if h.learned == learned && opts.Now == nil && now < h.until {
			return h.e
		}
	}
	id := BareModelID(model)
	sources := []any{}
	data := u.NewObj()
	if fam := FamilyOf(id); fam != nil {
		rest := fam.Clone()
		rest.Delete("match")
		data = Merge(data, rest)
		sources = append(sources, "family")
	}
	if cat := CatalogEntry(id); cat != nil {
		data = Merge(data, cat)
		sources = append(sources, "catalog")
	}
	spec := providers.SpecOf(p, "")
	for _, x := range spec.Models {
		hit := false
		for _, g := range x.Match {
			if GlobRe(g).MatchString(id) {
				hit = true
				break
			}
		}
		if hit {
			data = Merge(data, x.Spec)
			sources = append(sources, "provider")
			break
		}
	}
	var lm *config.LearnedModel
	proto := false
	if learned != nil && learned.Models != nil {
		if x, ok := learned.Models[model]; ok {
			lm = &x
		} else if IsProtoKey(model) {
			proto = true
		}
	}
	l := learnedData(lm, proto, now)
	ud, set := userData(p.Model(model))
	if l != nil {
		filtered := l.Clone()
		if contains(set, "reasoning.efforts") && filtered.Has("reasoning") {
			filtered.Delete("reasoning")
		}
		data = Merge(data, filtered)
		sources = append(sources, "learned")
	}
	if len(set) > 0 {
		data = Merge(data, ud)
		sources = append(sources, "user")
	}
	strict := false
	if m := p.Model(model); m != nil && m.Strict != nil {
		strict = *m.Strict
	} else if opts.Strict != nil {
		strict = *opts.Strict
	}
	e := data.Clone()
	e.Set("id", id).Set("userSet", strs(set)).Set("sources", sources).Set("strict", strict).Set("catalogVersion", CatalogVersion)
	until := math.Inf(1)
	if l != nil && (lm != nil || proto) {
		if proto {
			until = math.NaN()
		} else {
			until = lm.At + LearnedTTLMs
		}
	}
	if opts.Now == nil {
		memo.Store(key, &effHit{learned: learned, until: until, e: e})
	}
	return e
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
