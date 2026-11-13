package island

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSizeDefaultsAndPersistence(t *testing.T) {
	for _, value := range []any{nil, "invalid", 1} {
		if got := Sanitize(map[string]any{"size": value}, "darwin").Size; got != "large" {
			t.Fatalf("legacy/invalid size: %q", got)
		}
	}
	file := filepath.Join(t.TempDir(), "island.json")
	s := New(file, "darwin")
	for _, size := range []string{"small", "medium", "large"} {
		if _, err := s.Set(map[string]any{"size": size}); err != nil {
			t.Fatal(err)
		}
		if got := New(file, "darwin").Get().Size; got != size {
			t.Fatalf("persisted %s, want %s", got, size)
		}
		if _, err := s.Set(map[string]any{"style": "pill"}); err != nil {
			t.Fatal(err)
		}
		if s.Get().Size != size {
			t.Fatal("unrelated setting reset size")
		}
	}
}

func TestSizeGeometryAndHTML(t *testing.T) {
	t.Setenv("CD_ISLAND_SIMULATE_NOTCH", "0")
	d := Display{Bounds: Rect{Width: 1440, Height: 900}, WorkArea: Rect{Y: 24, Width: 1440, Height: 876}}
	large := IslandGeometry("darwin", d, "pill")
	if large.Width != 440 || large.Height != 64 {
		t.Fatalf("large changed: %+v", large)
	}
	for _, tc := range []struct {
		size          string
		width, height float64
	}{{"medium", 360, 56}, {"small", 300, 48}} {
		g := IslandGeometry("darwin", d, "pill", tc.size)
		if g.Width != tc.width || g.Height != tc.height || g.X != (1440-g.Width)/2 {
			t.Fatalf("%s: %+v", tc.size, g)
		}
		html := IslandHTML(g)
		if strings.Contains(html, "⟦preset⟧") || !strings.Contains(html, `data-size="`+tc.size+`"`) {
			t.Fatal("unresolved preset")
		}
	}
	t.Setenv("CD_ISLAND_SIMULATE_NOTCH", "1")
	for _, size := range []string{"large", "medium", "small"} {
		g := IslandGeometry("darwin", d, "auto", size)
		if g.Mode != "notch" || g.Y != 0 || g.Inset != 37 || g.Collapsed.Width != 196 {
			t.Fatalf("notch lost: %+v", g)
		}
	}
}

func TestSizeChangeDoesNotResetPendingOrNotification(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin")
	s.PrimaryDisplay = func() (Display, bool) { return Display{Bounds: Rect{Width: 1440, Height: 900}}, true }
	updates, destroys := 0, 0
	s.SetHost(Host{UpdateLayout: func(g Geometry) {
		updates++
		if g.Preset != "small" {
			t.Fatal(g.Preset)
		}
	}, Destroy: func() { destroys++ }})
	s.SetPending([]Pending{{ID: "request", Title: "waiting", Actions: []Action{{ID: "allow", Label: "Allow"}}}})
	s.mu.Lock()
	s.showing = true
	s.queue = []Notice{{Title: "queued"}}
	s.mu.Unlock()
	if _, err := s.Set(map[string]any{"size": "small"}); err != nil {
		t.Fatal(err)
	}
	if updates != 1 || destroys != 0 || !s.showing || len(s.queue) != 1 || len(s.Pending()) != 1 {
		t.Fatal("size change disturbed task state")
	}
}
