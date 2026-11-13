//go:build nomi_dev

package migrate_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
)

func TestDevStartupDoesNotImportProduction(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NOMI_APP_DATA", root)
	t.Setenv("NOMI_DEV_APP_DATA", root)
	t.Setenv("NOMI_DEV_USER_DATA", "")
	for _, name := range []string{"Nomi", "@nomi-ai/electron", "@ig-live/electron"} {
		write(t, filepath.Join(root, name, "settings.json"), `{"production":true}`)
	}
	dev := hostports.DefaultPaths().UserData()
	if err := os.MkdirAll(dev, 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := migrate.RunFiles(dev)
	if err != nil || result.Migrated || result.SecretsPending || !result.Skipped {
		t.Fatalf("migration = %+v, %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(dev, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("production data imported: %v", err)
	}
	for _, name := range []string{"Nomi", "@nomi-ai/electron", "@ig-live/electron"} {
		raw, err := os.ReadFile(filepath.Join(root, name, "settings.json"))
		if err != nil || string(raw) != `{"production":true}` {
			t.Fatalf("production data changed: %s, %v", name, err)
		}
	}
}
