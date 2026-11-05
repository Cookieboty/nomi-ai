package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 总量超上限时从最旧的删，留下最新的；过期的照旧删
func TestPruneTracesTotalCap(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	write := func(name string, size int, age time.Duration) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
		mt := now.Add(-age)
		_ = os.Chtimes(p, mt, mt)
	}
	write("old.json", 10, 48*time.Hour)
	write("a.json", 100, 3*time.Hour)
	write("b.json", 100, 2*time.Hour)
	write("c.json", 100, 1*time.Hour)
	removed := pruneTraces(dir, float64(now.UnixMilli()), TraceMaxAgeMs, 250)
	if removed != 2 {
		t.Fatalf("removed=%d, want 2 (expired + oldest)", removed)
	}
	for name, want := range map[string]bool{"old.json": false, "a.json": false, "b.json": true, "c.json": true} {
		_, err := os.Stat(filepath.Join(dir, name))
		if (err == nil) != want {
			t.Errorf("%s exists=%v, want %v", name, err == nil, want)
		}
	}
}
