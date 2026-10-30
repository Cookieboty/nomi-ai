package mascothandlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascot"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 回放 scripts/parity/record-mascot.mjs 录下的 Node 输出（testdata/parity.json）

type caseT struct {
	In  json.RawMessage `json:"in"`
	Out json.RawMessage `json:"out"`
}

func canon(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var x any
	_ = json.Unmarshal(b, &x)
	return x
}

func same(t *testing.T, name string, want json.RawMessage, got any) {
	t.Helper()
	var w any
	_ = json.Unmarshal(want, &w)
	if g := canon(t, got); !reflect.DeepEqual(w, g) {
		gb, _ := json.Marshal(g)
		t.Errorf("%s: want %s got %s", name, want, gb)
	}
}

func load(t *testing.T) map[string]json.RawMessage {
	b, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func cases(t *testing.T, raw json.RawMessage) []caseT {
	var cs []caseT
	if err := json.Unmarshal(raw, &cs); err != nil {
		t.Fatal(err)
	}
	return cs
}

func anyOf(raw json.RawMessage) any {
	var v any
	_ = json.Unmarshal(raw, &v)
	return v
}

func TestMascotSizeParity(t *testing.T) {
	m := load(t)
	for _, c := range cases(t, m["clamp"]) {
		same(t, "clamp "+string(c.In), c.Out, mascot.ClampMascotScale(anyOf(c.In)))
	}
	for _, c := range cases(t, m["windowSize"]) {
		var v float64
		_ = json.Unmarshal(c.In, &v)
		same(t, "windowSize "+string(c.In), c.Out, mascot.MascotWindowSize(v))
	}
	for _, c := range cases(t, m["maxScale"]) {
		var a *mascot.AreaRect
		_ = json.Unmarshal(c.In, &a)
		same(t, "maxScale "+string(c.In), c.Out, mascot.MaxScaleForArea(a))
	}
	for _, c := range cases(t, m["fit"]) {
		var in []json.RawMessage
		_ = json.Unmarshal(c.In, &in)
		var cp float64
		_ = json.Unmarshal(in[1], &cp)
		same(t, "fit "+string(c.In), c.Out, mascot.FitMascotScale(anyOf(in[0]), cp))
	}
	for _, c := range cases(t, m["step"]) {
		var in []float64
		_ = json.Unmarshal(c.In, &in)
		same(t, "step "+string(c.In), c.Out, mascot.StepMascotScale(in[0], int(in[1]), in[2]))
	}
	for _, c := range cases(t, m["wheel"]) {
		var in []float64
		_ = json.Unmarshal(c.In, &in)
		same(t, "wheel "+string(c.In), c.Out, mascot.WheelMascotScale(in[0], in[1], in[2], in[3]))
	}
	for _, c := range cases(t, m["maxTop"]) {
		var in []json.RawMessage
		_ = json.Unmarshal(c.In, &in)
		var a mascot.AreaRect
		var h float64
		_ = json.Unmarshal(in[0], &a)
		_ = json.Unmarshal(in[1], &h)
		same(t, "maxTop "+string(c.In), c.Out, mascot.MaxTopInArea(a, h))
	}
	for _, c := range cases(t, m["resize"]) {
		var in mascot.ResizeInput
		_ = json.Unmarshal(c.In, &in)
		same(t, "resize "+string(c.In), c.Out, mascot.ResizeMascotBounds(in))
	}
}

func copyDir(t *testing.T, src, dst string) {
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCharacterPackParity(t *testing.T) {
	nomi := paritytest.RepoPath("characters/nomi")
	var cs map[string]struct {
		Manifest json.RawMessage `json:"manifest"`
		Out      json.RawMessage `json:"out"`
	}
	_ = json.Unmarshal(load(t)["character"], &cs)
	if len(cs) == 0 {
		t.Fatal("no character cases")
	}
	for name, c := range cs {
		ud := t.TempDir()
		if string(c.Manifest) != "null" {
			p := filepath.Join(ud, "character-pack")
			copyDir(t, nomi, p)
			if err := os.WriteFile(filepath.Join(p, "manifest.json"), c.Manifest, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		same(t, "character "+name, c.Out, character.NewService(ud, "", nomi).Active())
	}
}

// 补充用例；完整的 Node 录制 goldens 见 internal/core/island/island_parity_test.go（scripts/parity/record-island.mjs）
func TestSanitizeIsland(t *testing.T) {
	for _, c := range []struct {
		raw  any
		plat string
		want island.Settings
	}{
		{nil, "darwin", sett(true, "auto", true, true, true)},
		{nil, "linux", sett(false, "auto", true, true, true)},
		{map[string]any{"enabled": "yes", "style": "pill", "kinds": map[string]any{"message": false}}, "linux", sett(false, "pill", false, true, true)},
		{map[string]any{"enabled": true, "style": "notch", "kinds": map[string]any{"agent": 0.0, "reminder": false}}, "win32", sett(true, "auto", true, true, false)},
	} {
		if got := island.Sanitize(c.raw, c.plat); got != c.want {
			t.Errorf("%v %s: got %+v", c.raw, c.plat, got)
		}
	}
	dir := t.TempDir()
	s := island.New(filepath.Join(dir, "island.json"), "linux")
	got, err := s.Set(map[string]any{"enabled": true, "kinds": map[string]any{"agent": false}})
	if err != nil || got != (sett(true, "auto", true, false, true)) {
		t.Fatalf("set: %+v %v", got, err)
	}
	if st := island.New(filepath.Join(dir, "island.json"), "linux").Get(); st.Settings != got || st.Mode != "pill" || st.Platform != "linux" {
		t.Fatalf("reload: %+v", st)
	}
}

func sett(en bool, style string, msg, agent, rem bool) island.Settings {
	return island.Settings{Enabled: en, Style: style, Kinds: island.Kinds{Message: msg, Agent: agent, Reminder: rem}}
}
