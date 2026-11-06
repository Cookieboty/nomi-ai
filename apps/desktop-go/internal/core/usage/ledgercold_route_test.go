package usage

import (
	"testing"
	"time"
)

// #270：路由记录冷归档后，重新扫到对应的旧工具日志不再当成新请求重复入账

func coldRouteFixture(now float64) (*UsageRecord, *UsageRecord) {
	ts := now - 100*dayMs
	route := &UsageRecord{Key: "route:codex:1", Ts: ts, Source: "codex", Via: "route", Model: "m-a",
		Input: 1000, Output: 100, Session: strp("sess"), Dur: f64p(5000)}
	log := &UsageRecord{Key: "codex:sess:1100", Ts: ts + 2000, Source: "codex", Via: "log", Model: "m-a",
		Input: 1000, Output: 100, Session: strp("sess")}
	return route, log
}

func archive(t *testing.T, l *UsageLedger, env *coldTestEnv, dir string) *UsageLedger {
	t.Helper()
	<-l.Compact()
	l.Flush()
	l.Close()
	re := newColdTestLedger(t, dir, env, 62)
	if re.Get("route:codex:1") != nil {
		t.Fatal("route record should be cold now")
	}
	return re
}

func TestColdRouteStillCoversRescannedLog(t *testing.T) {
	end := float64(time.Date(2026, 11, 5, 15, 30, 0, 0, time.Local).UnixMilli())
	route, log := coldRouteFixture(end)
	// 热状态下先归因，再归档
	env := &coldTestEnv{now: route.Ts + dayMs, priceOf: coldTestPrices(1)}
	dir := t.TempDir()
	l := newColdTestLedger(t, dir, env, 62)
	l.Upsert(route)
	s := &UsageLogScanner{d: ScannerDeps{Ledger: l}}
	if n := s.ingest([]UsageRecord{*log}); n != 1 || l.Get(route.Key).LogKey == nil {
		t.Fatalf("hot attribution: n=%v %+v", n, l.Get(route.Key))
	}
	env.now = end
	l = archive(t, l, env, dir)
	defer l.Close()
	s = &UsageLogScanner{d: ScannerDeps{Ledger: l}}
	if n := s.ingest([]UsageRecord{*log}); n != 0 || l.Has(log.Key) {
		t.Fatalf("rescanned log counted again: n=%v has=%v", n, l.Has(log.Key))
	}
}

func TestColdRouteCoversLogFirstSeenAfterArchive(t *testing.T) {
	end := float64(time.Date(2026, 11, 5, 15, 30, 0, 0, time.Local).UnixMilli())
	route, log := coldRouteFixture(end)
	env := &coldTestEnv{now: route.Ts + dayMs, priceOf: coldTestPrices(1)}
	dir := t.TempDir()
	l := newColdTestLedger(t, dir, env, 62)
	l.Upsert(route)
	env.now = end
	l = archive(t, l, env, dir)
	defer l.Close()
	s := &UsageLogScanner{d: ScannerDeps{Ledger: l}}
	if n := s.ingest([]UsageRecord{*log}); n != 0 || l.Has(log.Key) {
		t.Fatalf("old log first seen after archive was counted: n=%v", n)
	}
	// 同一条日志再扫一次：仍算已覆盖
	if n := s.ingest([]UsageRecord{*log}); n != 0 {
		t.Fatalf("second rescan counted: n=%v", n)
	}
	// 另一个请求（不同 key，时间 / token 相近）：冷路由已被认领，照常入账，不被吞掉
	other := *log
	other.Key, other.Ts = "codex:sess:2200", log.Ts+1000
	if n := s.ingest([]UsageRecord{other}); n != 1 || !l.Has(other.Key) {
		t.Fatalf("distinct request swallowed by a claimed cold route: n=%v", n)
	}
	// 附近没有路由记录的旧日志照常入账
	far := *log
	far.Key, far.Ts = "codex:other:1", log.Ts-3*dayMs
	if n := s.ingest([]UsageRecord{far}); n != 1 {
		t.Fatalf("unrelated old log not counted: n=%v", n)
	}
}
