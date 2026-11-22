package convstore

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestManagedPlatformDurabilityGate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "managed.json")
	err := atomicManaged(path, []byte("complete unit"), defaultManagedIO())
	if runtime.GOOS == "windows" {
		if !errors.Is(err, ErrDurabilityUnsupported) {
			t.Fatalf("Windows claimed unimplemented directory durability: %v", err)
		}
		if _, err = os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("unsupported platform published authority")
		}
	} else {
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != "complete unit" {
			t.Fatal("supported platform lost payload")
		}
	}
}
