package convstore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagedPlatformDurabilityGate(t *testing.T) {
	if !ManagedSupported() {
		t.Fatal("managed durability unexpectedly disabled")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "managed.json")
	if err := atomicManaged(path, []byte("complete unit"), defaultManagedIO()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "complete unit" {
		t.Fatal("supported platform lost payload")
	}
}
