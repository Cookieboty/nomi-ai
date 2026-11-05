package usage

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 冷热分层与「全部记录常驻内存」逐位一致：同一批记录，参照账本热窗口无限大（等同旧实现），
// 被测账本热窗口 62 天、压缩后把早于窗口的记录挪进日文件；比较每个读者的输出（含价格变更后）。

var coldTestLabels = &Labels{ProviderName: func(id string) (string, bool) {
	if id == "p1" {
		return "Prov One", true
	}
	return "", false
}}

func coldTestPrices(v int) PriceOf {
	synced := []PriceEntry{
		{Model: "m-a", ModelPrice: ModelPrice{Input: 3, Output: 15, CacheRead: f64p(0.3), CacheWrite: f64p(3.75),
			Tiers: []PriceTier{{Size: 200_000, Input: 6, Output: 22.5}}}},
		{Model: "m-b", ModelPrice: ModelPrice{Input: 0.7, Output: 2.1}},
	}
	var custom []PriceEntry
	if v == 2 {
		synced[0].Input = 3.3
		custom = []PriceEntry{{Model: "m-c", ModelPrice: ModelPrice{Input: 1.1, Output: 4.4}}}
	}
	return MakePriceOf(custom, synced)
}

func coldTestRecords(now float64, n int, odd bool) []*UsageRecord {
	rnd := rand.New(rand.NewSource(7))
	sources := []string{"claude", "codex", "nomi"}
	vias := []string{"log", "route", "chat"}
	models := []string{"m-a", "m-b", "m-c", "unknown-x"}
	var out []*UsageRecord
	prevTs := 0.0
	for i := 0; i < n; i++ {
		ts := now - rnd.Float64()*200*dayMs
		if i%17 == 0 && prevTs != 0 {
			ts = prevTs // 同 ts 的记录
		}
		ts = math.Floor(ts)
		prevTs = ts
		r := &UsageRecord{Key: fmt.Sprintf("k%05d", i), Ts: ts, Source: sources[rnd.Intn(3)], Via: vias[rnd.Intn(3)],
			Model: models[rnd.Intn(4)], Input: float64(rnd.Intn(300_000)), Output: float64(rnd.Intn(5000)),
			CacheRead: float64(rnd.Intn(100_000)), CacheWrite: float64(rnd.Intn(20_000))}
		switch rnd.Intn(4) {
		case 0:
			r.Provider = strp("p1")
		case 1:
			r.Provider = strp("")
		}
		switch k := rnd.Intn(8); {
		case k < 5:
			r.Session = strp(fmt.Sprintf("s%d", k))
		case k == 5:
			r.Session = strp("")
		}
		if rnd.Intn(5) == 0 {
			r.Est = boolp(true)
		}
		if rnd.Intn(6) == 0 {
			r.CacheWrite1h = f64p(math.Floor(r.CacheWrite / 2))
		}
		if rnd.Intn(9) == 0 {
			r.Fast = boolp(true)
		}
		out = append(out, r)
	}
	if odd {
		for i, line := range []string{
			`{"key":"odd1","ts":%d,"source":"claude","via":"log","model":"m-a","input":"12","output":3,"cacheRead":0,"cacheWrite":0}`,
			`{"key":"odd2","ts":%d,"source":"codex","via":"log","model":"m-b","input":1.1,"output":0.2,"cacheRead":0,"cacheWrite":0}`,
			`{"key":"odd3","ts":%d,"source":"claude","via":"log","model":"m-c","input":5,"output":3,"cacheWrite":0}`,
		} {
			ts := int64(now - float64(100+i*20)*dayMs)
			r := parseLine(fmt.Sprintf(line, ts))
			if r == nil {
				panic(line)
			}
			out = append(out, r)
		}
	}
	return out
}

type coldTestEnv struct {
	now     float64
	priceOf PriceOf
}

func newColdTestLedger(t *testing.T, root string, env *coldTestEnv, hot int) *UsageLedger {
	t.Helper()
	big := int64(1 << 40)
	return NewUsageLedger(LedgerDeps{Root: root, Now: func() float64 { return env.now }, HotDays: &hot,
		SyncLoadMaxBytes: &big, PriceOf: func() PriceOf { return env.priceOf }})
}

func js(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// readers：服务里各个读者的输出（同 usageservice.go 的计算）
func coldReaders(t *testing.T, l *UsageLedger, env *coldTestEnv) map[string]string {
	t.Helper()
	now, po := env.now, env.priceOf
	out := map[string]string{}
	for _, id := range []string{"today", "7d", "30d", "90d"} {
		out["query:"+id] = js(t, queryRows(l, RangeOf(id, now), po, coldTestLabels))
	}
	today := StartOfDay(now)
	out["heatmap"] = js(t, heatmapRows(l.Rows(AddDays(today, -364), AddDays(today, 1), math.Inf(1), po), now, po, 365))
	sessions := map[string]*SessionUsage{}
	for _, w := range l.Rows(math.Inf(-1), math.Inf(1), math.Inf(1), po) {
		if s := w.session(); truthy(s) {
			k := w.source() + ":" + *s
			if sessions[k] == nil {
				sessions[k] = newSessionUsage()
			}
			accumulateRow(sessions[k], w, po)
		}
	}
	for k, e := range sessions {
		e.finish()
		out["session:"+k] = js(t, e.ToObj())
	}
	for _, src := range []string{"claude", "codex", "nomi"} {
		for _, back := range []float64{0.3, 5, 70.5, 150} {
			for _, sess := range []string{"", "s1"} {
				e := newSessionUsage()
				for _, w := range l.Rows(now-back*dayMs, now+1, math.Inf(1), po) {
					s := w.session()
					if w.source() != src || (sess != "" && (s == nil || *s != sess) && !(w.via() == "route" && !truthy(s))) {
						continue
					}
					accumulateRow(e, w, po)
				}
				e.finish()
				out[fmt.Sprintf("since:%s:%v:%s", src, back, sess)] = js(t, e.ToObj())
			}
		}
		week := RangeOf("7d", now)
		recs := filterRows(l.Rows(week.From, week.To, math.Inf(1), po), func(w aggRow) bool { return w.source() == src })
		out["endpoint:"+src] = js(t, []any{summarizeRows(recs, po), seriesRows(recs, week, po), breakdownRows(recs, "model", po, coldTestLabels)})
		last, ok := l.LastTs(src)
		out["last:"+src] = fmt.Sprint(last, ok)
	}
	for _, q := range []DetailQuery{
		{From: now - 190*dayMs, To: now - 80*dayMs},
		{From: now - 120.5*dayMs, To: now - 3.2*dayMs, Source: "claude", Sort: "cost", Dir: "asc"},
		{From: 0, To: now + 1, Model: "m-a", Session: "s1", Sort: "tokens"},
	} {
		out[fmt.Sprintf("details:%v", q.From)] = js(t, Details(l.Range(q.From, q.To), q, po, coldTestLabels))
		rows := []DetailRow{}
		for _, r := range l.Range(q.From, q.To) {
			rows = append(rows, ToRow(r, po, coldTestLabels))
		}
		out[fmt.Sprintf("csv:%v", q.From)] = ToCsv(rows, "USD", 7)
	}
	out["size"] = fmt.Sprint(l.Size())
	out["all"] = fmt.Sprint(len(l.All()))
	return out
}

func compareReaders(t *testing.T, label string, want, got map[string]string) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("%s: reader count %d vs %d", label, len(want), len(got))
	}
	for k, w := range want {
		if got[k] != w {
			a, b := w, got[k]
			if len(a) > 300 {
				a, b = a[:300], b[:min(300, len(b))]
			}
			t.Fatalf("%s: %s differs\nwant %s\n got %s", label, k, a, b)
		}
	}
}

func TestColdLedgerMatchesAllInMemory(t *testing.T) {
	for _, odd := range []bool{false, true} {
		t.Run(fmt.Sprint("odd=", odd), func(t *testing.T) {
			env := &coldTestEnv{now: float64(time.Date(2026, 11, 5, 15, 30, 0, 0, time.Local).UnixMilli()), priceOf: coldTestPrices(1)}
			recs := coldTestRecords(env.now, 6000, odd)
			ref := newColdTestLedger(t, t.TempDir(), env, 1_000_000)
			dir := t.TempDir()
			l := newColdTestLedger(t, dir, env, 62)
			for _, r := range recs {
				ref.Upsert(r)
				l.Upsert(r)
			}
			ref.Flush()
			want := coldReaders(t, ref, env)
			compareReaders(t, "before compact", want, coldReaders(t, l, env))
			<-l.Compact()
			l.Flush()
			ents, _ := os.ReadDir(filepath.Join(dir, coldDirName))
			if len(ents) < 100 {
				t.Fatalf("expected day files, got %d", len(ents))
			}
			if l.recs.size() > 6000*70/200 {
				t.Fatalf("hot records not bounded: %d", l.recs.size())
			}
			groups := 0
			for _, w := range l.Rows(math.Inf(-1), math.Inf(1), math.Inf(1), env.priceOf) {
				if w.g != nil {
					groups++
				}
			}
			if (groups == 0) != odd {
				t.Fatalf("group rows = %d (odd=%v)", groups, odd)
			}
			compareReaders(t, "after compact", want, coldReaders(t, l, env))
			l.Close()

			idx := filepath.Join(dir, coldDirName, coldIndexName)
			if _, err := os.Stat(idx); err != nil {
				t.Fatal("cold index not written")
			}
			re := newColdTestLedger(t, dir, env, 62)
			compareReaders(t, "reloaded", want, coldReaders(t, re, env))
			re.Close()
			// 索引坏了 / 没了：逐行解析，结果一样
			if err := os.WriteFile(idx, []byte("garbage"), 0o600); err != nil {
				t.Fatal(err)
			}
			re = newColdTestLedger(t, dir, env, 62)
			compareReaders(t, "reloaded without index", want, coldReaders(t, re, env))
			if got := readColdIndex(filepath.Join(dir, coldDirName)); len(got) != len(re.dayIDs) {
				t.Fatalf("index rebuilt with %d days, want %d", len(got), len(re.dayIDs))
			}
			re.Close()
			// ledger.jsonl 里又出现冷 key（压缩到一半崩溃 / 旧版本重扫）：以 ledger.jsonl 为准
			seen := map[float64]int{}
			for _, r := range recs {
				seen[r.Ts]++
			}
			var dup *UsageRecord
			for _, r := range recs {
				if r.Ts < AddDays(StartOfDay(env.now), -70) && seen[r.Ts] == 1 && rollupable(r) {
					dup = r
					break
				}
			}
			in := cloneRec(dup)
			in.Output += 1234
			ref.Upsert(in)
			f, _ := os.OpenFile(filepath.Join(dir, "ledger.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
			_, _ = f.WriteString(stringifyRec(mergeRecord(dup, in)) + "\n")
			f.Close()
			want = coldReaders(t, ref, env)
			re = newColdTestLedger(t, dir, env, 62)
			compareReaders(t, "cold key shadowed by ledger.jsonl", want, coldReaders(t, re, env))

			// 冷 key：认得、不合并
			old := recs[0]
			for _, r := range recs {
				if r.Ts < re.hotCutoff() {
					old = r
					break
				}
			}
			bumped := cloneRec(old)
			bumped.Output += 10
			if !re.Has(old.Key) || re.Get(old.Key) != nil || re.Upsert(bumped) {
				t.Fatal("cold key should be known, not returned, not merged")
			}
			// 早于热窗口的新 key：照常收下，压缩后进日文件
			fresh := cloneRec(old)
			fresh.Key = "fresh-old"
			fresh.Ts -= 1
			if !re.Upsert(fresh) || !ref.Upsert(fresh) {
				t.Fatal("new old record should be accepted")
			}
			want = coldReaders(t, ref, env)
			compareReaders(t, "new cold key", want, coldReaders(t, re, env))
			<-re.Compact()
			compareReaders(t, "new cold key compacted", want, coldReaders(t, re, env))

			// 价格变更：冷天先给旧价格的费用，后台重算完与参照一致
			env.priceOf = coldTestPrices(2)
			want = coldReaders(t, ref, env)
			today := StartOfDay(env.now)
			staleHeat := js(t, heatmapRows(re.Rows(AddDays(today, -364), AddDays(today, 1), math.Inf(1), env.priceOf), env.now, env.priceOf, 365))
			_ = coldReaders(t, re, env) // 用到过期分组的读者都会触发重算
			re.waitRecompute()
			if !odd && staleHeat == want["heatmap"] {
				t.Fatal("expected cold days to show old prices until recomputed")
			}
			compareReaders(t, "price change", want, coldReaders(t, re, env))

			// 保留期：冷天读时就按截止时间过滤，压缩后改日文件
			ref.Prune("90d")
			re.Prune("90d")
			want = coldReaders(t, ref, env)
			got := coldReaders(t, re, env)
			delete(want, "size")
			delete(got, "size")
			compareReaders(t, "pruned", want, got)
			<-re.Compact()
			<-ref.Compact()
			want = coldReaders(t, ref, env)
			compareReaders(t, "pruned compacted", want, coldReaders(t, re, env))
			re.Close()
			compareReaders(t, "pruned reloaded", want, coldReaders(t, newColdTestLedger(t, dir, env, 62), env))
		})
	}
}

// exactSum 与逐条相加只差舍入误差
func TestExactSumCloseToSequential(t *testing.T) {
	rnd := rand.New(rand.NewSource(3))
	var s exactSum
	seq := 0.0
	for i := 0; i < 100_000; i++ {
		x := rnd.Float64() * 0.37
		s.add(x)
		seq += x
	}
	if d := math.Abs(s.value() - seq); d > 1e-9*seq {
		t.Fatalf("exact %v vs sequential %v", s.value(), seq)
	}
	var a, b exactSum
	a.add(0.1)
	a.add(0.2)
	b.add(0.3)
	b.addSum(&a)
	if b.value() != 0.6 {
		t.Fatalf("0.1+0.2+0.3 = %v", b.value())
	}
}
