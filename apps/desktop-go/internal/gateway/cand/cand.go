// Package cand holds the Candidate and RoutePlan types of route/resolve.ts and
// route/plan.ts. They live in their own leaf package so providers, models and
// route can share them without an import cycle (Node has no such constraint).
package cand

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Loss is route/plan.ts Loss.
type Loss = string

// RoutePlan is route/plan.ts RoutePlan. Ingress "" is null.
type RoutePlan struct {
	Ingress  string
	Upstream string
	Why      []string
	Losses   []Loss
	Quality  string
	Legacy   string // "" = absent
}

// JSON is the plan as JS would serialise it (key order of the object literal).
func (p *RoutePlan) JSON() *u.Obj {
	var ing any
	if p.Ingress != "" {
		ing = p.Ingress
	}
	o := u.NewObj("ingress", ing, "upstream", p.Upstream, "why", strs(p.Why), "losses", strs(p.Losses), "quality", p.Quality)
	if p.Legacy != "" {
		o.Set("legacy", p.Legacy)
	}
	return o
}

func strs(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// Candidate is route/resolve.ts Candidate.
type Candidate struct {
	Provider               *config.RuntimeProvider
	Key                    *config.RuntimeKey
	PublicModel            string
	UpstreamModel          string
	Wire                   string
	DropParams             []string
	CustomToolsAsFunctions bool
	// Model is the EffectiveModel (nil = not computed).
	Model   *u.Obj
	Plan    *RoutePlan
	Rectify []string
}

// ShortModel is c.publicModel.slice(c.provider.id.length + 1).
func (c *Candidate) ShortModel() string {
	// publicModel is always built as `${p.id}/${model}`, so byte offsets equal UTF-16 ones.
	n := len(c.Provider.ID) + 1
	if n > len(c.PublicModel) {
		return ""
	}
	return c.PublicModel[n:]
}

// Clone is `{ ...c }`.
func (c *Candidate) Clone() *Candidate {
	x := *c
	return &x
}
