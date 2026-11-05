package quality

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 回放用例覆盖不到的边界常量。
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

// 开发者工具：quality.requests 按标签筛（tabId）
func TestRequestsTabFilter(t *testing.T) {
	now := 1_800_000_000_000.0
	svc := New(ServiceDeps{Dir: t.TempDir(), FlushMs: -1, Now: func() float64 { return now }})
	defer svc.Dispose()
	for i, tab := range []string{"tab-a", "tab-b", ""} {
		r := u.NewObj("id", "r"+u.FormatNumber(float64(i)), "ts", now-float64(i+1)*1000, "layer", "gateway",
			"client", "x", "source", "thirdParty", "stream", true, "status", 200.0, "outcome", "ok",
			"timing", u.NewObj("endMs", 1.0), "tokens", u.NewObj(), "model", "m")
		if tab != "" {
			r.Set("tabId", tab)
		}
		svc.Ledger.Append(r)
	}
	res := svc.Requests(u.NewObj("from", now-dayMs, "to", now+1, "limit", 10.0, "tabId", "tab-a"))
	items, _ := res.Get("items").([]any)
	if len(items) != 1 || res.Get("total") != 1.0 {
		t.Fatalf("tab filter: %d items, total %v", len(items), res.Get("total"))
	}
	if id, _ := items[0].(*u.Obj).Get("id").(string); id != "r0" {
		t.Fatalf("got %s", id)
	}
	// 不合法的标签 id 忽略（不筛）
	all := svc.Requests(u.NewObj("from", now-dayMs, "to", now+1, "limit", 10.0, "tabId", "../x"))
	if all.Get("total") != 3.0 {
		t.Fatalf("bad tab id must not filter: %v", all.Get("total"))
	}
}
