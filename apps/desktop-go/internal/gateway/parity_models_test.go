package gateway_test

import (
	"encoding/json"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestCatalogJSONMatchesTS(t *testing.T) {
	a, err1 := os.ReadFile(filepath.Join("models", "catalog.json"))
	b, err2 := os.ReadFile(paritytest.RepoPath("apps/desktop-electron/internal/gateway/src/models/catalog.json"))
	if err1 != nil || err2 != nil {
		paritytest.SkipOrFail(t, "TS tree not present")
	}
	if string(a) != string(b) {
		t.Fatal("internal/gateway/models/catalog.json differs from apps/desktop-electron/internal/gateway/src/models/catalog.json; copy it over")
	}
}

func TestParityModels(t *testing.T) {
	var fx struct {
		Families string
		FamilyOf []struct {
			ID     string
			Family *string
		}
		Catalog        []struct{ ID, Bare, Entry string }
		CatalogVersion string
		CatalogSize    int
		Providers      []json.RawMessage
		Learneds       []json.RawMessage
		Now            float64
		Effective      []struct {
			Provider, Learned int
			Strict            *bool
			Model, Output     string
		}
		Builds []struct {
			API     json.RawMessage
			Version string
			Output  string
		}
		SortKeys, Sorted []string
		Listing          []struct {
			Format string
			Cfg    json.RawMessage
			Output string
		}
	}
	loadFixture(t, "models", &fx)
	providers.RegisterProviderSpec(&providers.Spec{ID: "parity-models", Models: []providers.ModelOverride{
		{Match: []string{"foo-*"}, Spec: u.NewObj("limits", u.NewObj("context", 1234.0), "tools", u.NewObj("calling", false))},
		{Match: []string{"claude-x*"}, Spec: u.NewObj("reasoning", u.NewObj("control", "effort", "efforts", []any{"low"}))},
	}})
	tl := tally{}
	fams := []any{}
	for _, f := range models.Families {
		fams = append(fams, f)
	}
	check := func(k, got, want, ctx string) {
		ok := got == want
		if !ok {
			t.Errorf("%s %s:\n got %s\nwant %s", k, ctx, got, want)
		}
		tl.add(k, ok)
	}
	check("families", u.Stringify(fams), fx.Families, "")
	check("version", models.CatalogVersion, fx.CatalogVersion, "")
	check("size", u.Stringify(float64(models.CatalogSize())), u.Stringify(float64(fx.CatalogSize)), "")
	for _, c := range fx.FamilyOf {
		var got any
		if f := models.FamilyOf(models.BareModelID(c.ID)); f != nil {
			got = f.Get("family")
		}
		var want any
		if c.Family != nil {
			want = *c.Family
		}
		check("familyOf", u.Stringify(got), u.Stringify(want), c.ID)
	}
	for _, c := range fx.Catalog {
		check("bare", models.BareModelID(c.ID), c.Bare, c.ID)
		var e any
		if x := models.CatalogEntry(c.ID); x != nil {
			e = x
		}
		want := c.Entry
		if want == "" { // Node returned an Object.prototype function (JSON undefined): Go models it as {}
			want = "{}"
		}
		check("catalog", u.Stringify(e), want, c.ID)
	}
	var provs []config.RuntimeProvider
	for _, raw := range fx.Providers {
		var p config.RuntimeProvider
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		provs = append(provs, p)
	}
	var learneds []*config.LearnedState
	for _, raw := range fx.Learneds {
		var l *config.LearnedState
		if err := json.Unmarshal(raw, &l); err != nil {
			t.Fatal(err)
		}
		learneds = append(learneds, l)
	}
	for _, c := range fx.Effective {
		now := fx.Now
		got := models.EffectiveModel(&provs[c.Provider], c.Model, learneds[c.Learned], models.EffectiveOpts{Strict: c.Strict, Now: &now})
		check("effective", u.Stringify(got), c.Output, c.Model)
	}
	for _, c := range fx.Builds {
		api, _ := u.Parse(c.API)
		r := models.BuildCatalog(api, c.Version)
		o := r.JSON().Set("fromFallback", float64(r.FromFallback))
		check("build", u.Stringify(o), c.Output, c.Version)
	}
	keys := append([]string(nil), fx.SortKeys...)
	sort.SliceStable(keys, func(i, j int) bool { return models.LocaleCompare(keys[i], keys[j]) < 0 })
	check("sort", u.Stringify(strs(keys)), u.Stringify(strs(fx.Sorted)), "")
	for _, c := range fx.Listing {
		var cfg config.GatewayConfig
		if err := json.Unmarshal(c.Cfg, &cfg); err != nil {
			t.Fatal(err)
		}
		check("listing", u.Stringify(models.ModelsBody(&cfg, c.Format)), c.Output, c.Format)
	}
	tl.report(t, "models")
}

func strs(xs []string) []any {
	out := []any{}
	for _, x := range xs {
		out = append(out, x)
	}
	return out
}
