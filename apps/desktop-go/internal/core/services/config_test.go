package services_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
)

func TestConfigDefaultsAndUpdate(t *testing.T) {
	dir := t.TempDir()
	c := services.NewConfig(dir)
	if c.GetConfig().MascotScale != services.DefaultMascotScale {
		t.Fatal(c.GetConfig().MascotScale)
	}
	if err := c.UpdateConfig(map[string]any{"mascotScale": 0.8, "debug": true}); err != nil {
		t.Fatal(err)
	}
	c2 := services.NewConfig(dir)
	got := c2.GetConfig()
	if got.MascotScale != 0.8 || !got.Debug {
		t.Fatalf("%+v", got)
	}
}
