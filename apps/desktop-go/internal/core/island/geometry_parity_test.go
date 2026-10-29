package island

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"testing"
)

type jsDisplay struct {
	Bounds, WorkArea Rect
	Internal         *bool `json:"internal"`
}

func (r *Rect) UnmarshalJSON(b []byte) error {
	var v struct{ X, Y, Width, Height float64 }
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*r = Rect(v)
	return nil
}

func TestGeometryParity(t *testing.T) {
	t.Setenv("CD_ISLAND_SIMULATE_NOTCH", "")
	raw, err := os.ReadFile("testdata/geometry.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []struct {
			Plat    string
			Display jsDisplay
			Pref    string
			G       json.RawMessage
			Rect    json.RawMessage
			Clamp   [][3]json.RawMessage
		}
		Pages []struct {
			G    Geometry
			HTML string
		}
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	js := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	for i, c := range g.Cases {
		d := Display{Bounds: c.Display.Bounds, WorkArea: c.Display.WorkArea, Internal: c.Display.Internal}
		geo := IslandGeometry(c.Plat, d, c.Pref)
		if got := js(geo); got != string(c.G) {
			t.Fatalf("case %d geometry:\n go=%s\nnode=%s", i, got, c.G)
		}
		if got := js(IslandWindowRect(geo, geo.Height)); got != string(c.Rect) {
			t.Fatalf("case %d rect: go=%s node=%s", i, got, c.Rect)
		}
		for _, cl := range c.Clamp {
			var ms string
			_ = json.Unmarshal(cl[0], &ms)
			m, _ := strconv.ParseFloat(ms, 64)
			switch ms {
			case "NaN":
				m = math.NaN()
			case "Infinity":
				m = math.Inf(1)
			}
			h := ClampIslandHeight(geo, m)
			if js(h) != string(cl[1]) || js(IslandWindowRect(geo, h)) != string(cl[2]) {
				t.Fatalf("case %d clamp(%s): go=%v %s node=%s %s", i, ms, h, js(IslandWindowRect(geo, h)), cl[1], cl[2])
			}
		}
	}
	for i, p := range g.Pages {
		if got := IslandHTML(p.G); got != p.HTML {
			t.Fatalf("page %d (%s) differs (len go=%d node=%d)", i, p.G.Mode, len(got), len(p.HTML))
		}
	}
	t.Logf("geometry %d cases, %d pages", len(g.Cases), len(g.Pages))
}
