package gateway_test

import (
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
)

func TestParityCollate(t *testing.T) {
	var fx struct {
		Pairs  [][3]any `json:"pairs"`
		Sorted []string `json:"sorted"`
	}
	loadFixture(t, "collate", &fx)
	tl := tally{}
	for _, p := range fx.Pairs {
		a, b, w := p[0].(string), p[1].(string), int(p[2].(float64))
		g := models.LocaleCompare(a, b)
		tl.add("compare", g == w)
		if g != w {
			t.Logf("compare %q %q got %d want %d", a, b, g, w)
		}
	}
	xs := append([]string(nil), fx.Sorted...)
	sort.Strings(xs)
	sort.SliceStable(xs, func(i, j int) bool { return models.LocaleCompare(xs[i], xs[j]) < 0 })
	tl.add("sort", eqStrs(xs, fx.Sorted))
	tl.report(t, "collate")
}
