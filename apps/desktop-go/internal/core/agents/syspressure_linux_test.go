package agents

import "testing"

func TestParseMeminfoAndPSI(t *testing.T) {
	if got := parseMeminfo("MemTotal:  1000 kB\nMemFree: 10 kB\nMemAvailable:  100 kB\n"); got != 10 {
		t.Fatalf("parseMeminfo = %v, want 10", got)
	}
	if got := parseMeminfo("MemTotal: 1000 kB\n"); got != -1 {
		t.Fatalf("parseMeminfo without MemAvailable = %v, want -1", got)
	}
	some, full := parsePSI("some avg10=12.50 avg60=1.00 avg300=0.10 total=1\nfull avg10=6.00 avg60=0 avg300=0 total=1\n")
	if some != 12.5 || full != 6 {
		t.Fatalf("parsePSI = %v %v", some, full)
	}
}
