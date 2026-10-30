package quality

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 录制回放覆盖不到的边界常量（gatewayRequests/qualityService 源码同值）。
func TestQualityLimits(t *testing.T) {
	if CsvCell("@SUM(A1)") != "'@SUM(A1)" {
		t.Fatalf("formula @ not escaped: %q", CsvCell("@SUM(A1)"))
	}
	long := strings.Repeat("x", 301)
	if r, _ := CleanError(long); r != strings.Repeat("x", 300)+"…" {
		t.Fatal("error clip != 300")
	}
	if r, _ := CleanError(strings.Repeat("x", 300)); r != strings.Repeat("x", 300) {
		t.Fatal("300 chars must not clip")
	}
	now := 1_800_000_000_000.0
	svc := New(ServiceDeps{Dir: t.TempDir(), FlushMs: -1, Now: func() float64 { return now }})
	defer svc.Dispose()
	q := svc.cleanQuery(u.NewObj("from", 0.0, "to", now, "groupPath", []any{"provider", "model", "client", "outcome"}))
	if q.To-q.From != 366*dayMs {
		t.Fatalf("range clamp %v", (q.To-q.From)/dayMs)
	}
	if len(q.GroupPath) != 3 {
		t.Fatalf("groupPath %v", q.GroupPath)
	}
	for i := 0; i < 120; i++ {
		svc.Ledger.Append(u.NewObj("id", "r"+u.FormatNumber(float64(i)), "ts", now-float64(i)*1000, "layer", "gateway",
			"client", "x", "source", "nomi", "stream", true, "status", 200.0, "outcome", "ok", "timing", u.NewObj("endMs", 1.0), "tokens", u.NewObj(), "model", "m"))
	}
	res := svc.Requests(u.NewObj("from", now-dayMs, "to", now+1))
	if items, _ := res.Get("items").([]any); len(items) != 100 {
		t.Fatalf("default limit: %d", len(items))
	}
	if n := len(svc.Ledger.Range(now-119_000, now)); n != 119 {
		t.Fatalf("range must be [from,to): %d", n)
	}
}
