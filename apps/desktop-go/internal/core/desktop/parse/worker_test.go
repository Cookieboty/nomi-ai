package parse

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if IsWorker() {
		WorkerMain()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestParseInWorkerProcess(t *testing.T) {
	EnableWorker(os.Args[0])
	defer EnableWorker("")
	d := t.TempDir()
	f := filepath.Join(d, "a.txt")
	_ = os.WriteFile(f, []byte("hello 世界"), 0o644)
	r := ParseFile(f, ParseOptions{})
	if !r.OK || r.Text != "hello 世界" {
		t.Fatalf("%+v", r)
	}
	if r := ParseFile(d, ParseOptions{}); r.Code != "not_file" {
		t.Fatalf("%+v", r)
	}
	if r := ParseFile(f, ParseOptions{MaxBytes: 3}); r.Code != "too_large" {
		t.Fatalf("%+v", r)
	}
	big := filepath.Join(d, "big.txt")
	_ = os.WriteFile(big, []byte(strings.Repeat("x", 40<<20)), 0o644)
	if r := ParseFile(big, ParseOptions{MemoryMb: 8}); r.Code != "crashed" || !strings.Contains(r.Message, "134") {
		t.Fatalf("%+v", r.Code+r.Message)
	}
}
