package usage

import (
	"encoding/json"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"os"
	"reflect"
	"testing"
	"time"
	_ "time/tzdata"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type fnCase struct {
	Fn   string            `json:"fn"`
	Args []json.RawMessage `json:"args"`
	Out  json.RawMessage   `json:"out"`
}

type fnsGolden struct {
	TZ      string       `json:"tz"`
	Custom  []PriceEntry `json:"custom"`
	Synced  []PriceEntry `json:"synced"`
	Now     float64      `json:"now"`
	CsvRows []DetailRow  `json:"csvRows"`
	Cases   []fnCase     `json:"cases"`
}

func normJSON(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func arg[T any](t *testing.T, c fnCase, i int) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(c.Args[i], &v); err != nil {
		t.Fatalf("%s arg %d: %v", c.Fn, i, err)
	}
	return v
}

func withTZ(t *testing.T, tz string) {
	t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Local
	time.Local = loc
	t.Cleanup(func() {
		// 先等后台异步原子写（pricesync 缓存等）结束：它们会读 time.Local（time.Now），否则 -race 报竞争。
		_, _ = jsrt.Block(utils.WhenPrivateWritesIdle())
		time.Local = old
	})
}

func numEq(a, b any) bool {
	if x, ok := a.(float64); ok {
		if y, ok := b.(float64); ok {
			return x == y
		}
	}
	return false
}

func deepEq(a, b any) bool {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if w, ok := y[k]; !ok || !deepEq(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !deepEq(x[i], y[i]) {
				return false
			}
		}
		return true
	case float64:
		return numEq(a, b)
	}
	return reflect.DeepEqual(a, b)
}

func TestUsageFnsParity(t *testing.T) {
	path, _ := paritytest.Golden(t, "usage-fns.json", "testdata/usage-fns.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g fnsGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	withTZ(t, g.TZ)
	var recs []*UsageRecord
	byKey := map[string]*UsageRecord{}
	priceOf := MakePriceOf(g.Custom, g.Synced)
	names := map[string]string{"p1": "Provider One", "p2": ""}
	labels := &Labels{ProviderName: func(id string) (string, bool) { v, ok := names[id]; return v, ok }}
	sub := func(id string) ([]*UsageRecord, RangeSpec) {
		rg := RangeOf(id, g.Now)
		out := []*UsageRecord{}
		for _, r := range recs {
			if r.Ts >= rg.From && r.Ts < rg.To {
				out = append(out, r)
			}
		}
		return out, rg
	}
	pass := 0
	for i, c := range g.Cases {
		var got any
		switch c.Fn {
		case "records":
			_ = json.Unmarshal(c.Out, &recs)
			for _, r := range recs {
				byKey[r.Key] = r
			}
			continue
		case "convertUsd":
			got = ConvertUsd(arg[float64](t, c, 0), arg[string](t, c, 1), arg[float64](t, c, 2))
		case "formatMoney":
			got = FormatMoney(arg[float64](t, c, 0), arg[string](t, c, 1), arg[float64](t, c, 2))
		case "currencySymbol":
			got = CurrencySymbol(arg[string](t, c, 0))
		case "formatAmount":
			got = FormatAmount(arg[float64](t, c, 0), arg[string](t, c, 1))
		case "formatTokens":
			got = FormatTokens(arg[float64](t, c, 0))
		case "sanitizeCustomPrices":
			if string(c.Args[0]) == `"fixture"` {
				continue
			}
			v, err := util.Parse(c.Args[0])
			if err != nil {
				t.Fatal(err)
			}
			got = SanitizeCustomPrices(v)
		case "normalizeModel":
			got = NormalizeModel(arg[string](t, c, 0))
		case "findPrice":
			var custom []PriceEntry
			if string(c.Args[1]) == `"custom"` {
				custom = g.Custom
			}
			got = FindPrice(arg[string](t, c, 0), custom, arg[[]PriceEntry](t, c, 2))
		case "tierPrice":
			got = TierPrice(arg[ModelPrice](t, c, 0), arg[float64](t, c, 1))
		case "costUsd":
			r := arg[UsageRecord](t, c, 0)
			got = JSNum(CostUsd(RecordCost(&r), arg[ModelPrice](t, c, 1)))
		case "startOfDay":
			got = StartOfDay(arg[float64](t, c, 0))
		case "dateKey":
			got = DateKey(arg[float64](t, c, 0))
		case "addDays":
			got = AddDays(arg[float64](t, c, 0), arg[int](t, c, 1))
		case "rangeOf":
			got = RangeOf(arg[string](t, c, 0), arg[float64](t, c, 1))
		case "summarize":
			s, _ := sub(arg[string](t, c, 0))
			got = Summarize(s, priceOf)
		case "series":
			s, rg := sub(arg[string](t, c, 0))
			got = Series(s, rg, priceOf)
		case "breakdown":
			s, _ := sub(arg[string](t, c, 0))
			var lb *Labels
			if arg[bool](t, c, 2) {
				lb = labels
			}
			got = Breakdown(s, arg[string](t, c, 1), priceOf, lb)
		case "vendorOfModel":
			v, ok := VendorOfModel(arg[string](t, c, 0))
			if ok {
				got = v
			} else {
				got = "__undef__"
			}
		case "providerOf":
			got = ProviderOf(byKey[arg[string](t, c, 0)], labels)
		case "heatmap":
			got = Heatmap(recs, arg[float64](t, c, 0), priceOf, arg[int](t, c, 1))
		case "details":
			got = Details(recs, arg[DetailQuery](t, c, 0), priceOf, labels)
		case "detailsBig":
			big := make([]*UsageRecord, 0, 1200)
			for i := 0; i < 1200; i++ {
				r := *recs[i%len(recs)]
				r.Key = "b" + util.JSString(float64(i))
				r.Ts += float64(i)
				big = append(big, &r)
			}
			d := Details(big, arg[DetailQuery](t, c, 0), priceOf, labels)
			keys := make([]string, len(d.Rows))
			for i, r := range d.Rows {
				keys[i] = r.Key
			}
			got = map[string]any{"rows": keys, "total": d.Total, "summary": d.Summary, "facets": d.Facets}
		case "toCsvRows":
			got = ToCsv(arg[[]DetailRow](t, c, 0), arg[string](t, c, 1), arg[float64](t, c, 2))
		case "jsSort":
			vs := arg[[]JSV](t, c, 0)
			dir := arg[float64](t, c, 1)
			idx := make([]int, len(vs))
			for i := range idx {
				idx[i] = i
			}
			jsSortStable(idx, func(x, y int) float64 { return (vs[x].Num() - vs[y].Num()) * dir })
			got = idx
		case "toCsv":
			got = ToCsv(g.CsvRows, arg[string](t, c, 0), arg[float64](t, c, 1))
		default:
			t.Fatalf("case %d: unknown fn %s", i, c.Fn)
		}
		var want any
		_ = json.Unmarshal(c.Out, &want)
		gv := normJSON(t, got)
		if !deepEq(gv, want) {
			gb, _ := json.Marshal(gv)
			t.Errorf("case %d %s(%s):\n got  %s\n want %s", i, c.Fn, c.Args, gb, c.Out)
			continue
		}
		pass++
	}
	t.Logf("usage fns parity: %d/%d", pass, len(g.Cases))
}
