package agents

import "testing"

func TestParseProcStat(t *testing.T) {
	busy, total, ok := parseProcStat("cpu  100 10 50 800 40 0 5 0 0 0\ncpu0 1 2 3 4\n")
	if !ok || total != 1005 || busy != 165 {
		t.Fatalf("parseProcStat = %v %v %v, want busy 165 total 1005", busy, total, ok)
	}
	if _, _, ok := parseProcStat("intr 1 2 3"); ok {
		t.Fatal("non-cpu line must fail")
	}
}
