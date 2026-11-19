package codinghandlers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

func TestProjectRemoveContractOutput(t *testing.T) {
	dir := t.TempDir()
	appDir := filepath.Join(dir, "store_system")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	store := projects.New(projects.Deps{
		File: filepath.Join(dir, "projects.json"),
		Check: func(d string) (string, string) {
			r, _ := filepath.EvalSymlinks(d)
			return r, ""
		},
	})
	created, err := store.Create("store_system", appDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := contract.NewRouter()
	RegisterProjects(r, store)

	fr := callAccounts(t, r, "project.remove", map[string]any{"id": created.ID})
	if fr.T != "res" || fr.Output != nil {
		t.Fatalf("expected res with nil output, got %+v", fr)
	}
	wire, err := contract.EncodeWire(fr)
	if err != nil {
		t.Fatal(err)
	}
	if string(wire) != `{"t":"res","id":"1"}` {
		t.Fatalf("unexpected wire frame: %s", wire)
	}
	if len(store.List()) != 0 {
		t.Fatalf("expected project removed, still got %d", len(store.List()))
	}
	if errFr := callAccounts(t, r, "project.remove", map[string]any{"id": created.ID}); errFr.T != "err" || errFr.Error.Code != "PROJECT_NOT_FOUND" {
		t.Fatalf("expected PROJECT_NOT_FOUND on second remove, got %+v", errFr)
	}
}
