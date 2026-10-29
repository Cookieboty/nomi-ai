package island

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// goldens: scripts/parity/record-island.mjs（Node 录制）
func TestIslandParity(t *testing.T) {
	t.Setenv("CD_ISLAND_SIMULATE_NOTCH", "")
	b, err := os.ReadFile("testdata/island.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Sanitize []struct {
			Plat, Input string
			Out         json.RawMessage
		}
		Notch []struct {
			Plat    string
			Display struct {
				Bounds, WorkArea Rect
				Internal         *bool
			}
			Style    string
			HasNotch bool
			Mode     string
		}
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Sanitize {
		var raw any
		_ = json.Unmarshal([]byte(c.Input), &raw)
		got, _ := json.Marshal(Sanitize(raw, c.Plat))
		var a, w any
		_ = json.Unmarshal(got, &a)
		_ = json.Unmarshal(c.Out, &w)
		if !reflect.DeepEqual(a, w) {
			t.Errorf("sanitize %s %s: want %s got %s", c.Plat, c.Input, c.Out, got)
		}
	}
	for _, c := range g.Notch {
		d := Display{Bounds: c.Display.Bounds, WorkArea: c.Display.WorkArea, Internal: c.Display.Internal}
		if HasNotch(c.Plat, d) != c.HasNotch || Mode(c.Plat, d, c.Style) != c.Mode {
			t.Errorf("notch %s %+v %s: want %v/%s", c.Plat, d, c.Style, c.HasNotch, c.Mode)
		}
	}
	t.Logf("sanitize %d, notch %d", len(g.Sanitize), len(g.Notch))
	if len(g.Sanitize) == 0 || len(g.Notch) == 0 {
		t.Fatal("empty goldens")
	}
}
