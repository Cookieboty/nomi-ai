package settings_test

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/settings"
)

func TestMascotRendererDefaultSVG(t *testing.T) {
	f := filepath.Join(t.TempDir(), "settings.json")
	s := settings.New(f)
	if s.Get().Mascot.Renderer != "svg" {
		t.Fatalf("%+v", s.Get())
	}
	if err := s.SetMascotRenderer("rive"); err != nil {
		t.Fatal(err)
	}
	s2 := settings.New(f)
	if s2.Get().Mascot.Renderer != "rive" {
		t.Fatalf("%+v", s2.Get())
	}
}
