package usage

import (
	"bytes"
	"encoding/gob"
	"math"
	"os"
	"path/filepath"
	"sort"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// 冷数据索引 ledger-days/index.gob：每个日文件的合计与 key 哈希，按文件大小 + 修改时间认；
// 对得上的日文件载入时不再逐行解析。索引丢了、坏了、对不上就重新解析那个日文件（索引只是缓存）。

const (
	coldIndexName = "index.gob"
	coldIndexV    = 1
)

type coldIndexFile struct {
	V    int
	Days []coldIndexDay
}

type coldIndexDay struct {
	Date        string
	Size, Mtime int64
	Lines, N    int
	Odd         int
	Misaligned  bool
	MinTs       float64
	MaxTs       float64
	LastBySrc   map[string]float64
	Keys        []uint64
	Groups      []coldIndexGroup
}

type coldIndexGroup struct {
	Source, Via, Model      string
	Provider, Session       string
	HasProvider, HasSession bool
	Est                     bool
	Calls, Input, Output    float64
	CacheRead, CacheWrite   float64
	FirstTs, LastTs         float64
	FirstOrd                int64 // 相对文件第一行
	Priced                  bool
	PriceKey                string
	Cost                    []float64
	PosInf, NegInf, NaN     bool
}

// coldHash：key 的 64 位 FNV-1a（写进索引，要跨进程稳定）
func coldHash(k string) uint64 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(k); i++ {
		h ^= uint64(k[i])
		h *= 1099511628211
	}
	return h
}

func (d *coldDay) toIndex(keys []uint64) coldIndexDay {
	e := coldIndexDay{Date: d.date, Size: d.size, Mtime: d.mtime, Lines: d.lines, N: d.n, Odd: d.odd, Misaligned: d.misaligned,
		MinTs: d.minTs, MaxTs: d.maxTs, LastBySrc: d.lastBySrc, Keys: keys}
	for _, g := range d.groups {
		x := coldIndexGroup{Source: g.source, Via: g.via, Model: g.model, Est: g.est,
			Calls: g.calls, Input: g.input, Output: g.output, CacheRead: g.cacheRead, CacheWrite: g.cacheWrite,
			FirstTs: g.firstTs, LastTs: g.lastTs, FirstOrd: g.firstOrd - d.base, Priced: g.priced, PriceKey: g.priceKey,
			Cost: g.cost.p, PosInf: g.cost.posInf, NegInf: g.cost.negInf, NaN: g.cost.nan}
		if g.provider != nil {
			x.Provider, x.HasProvider = *g.provider, true
		}
		if g.session != nil {
			x.Session, x.HasSession = *g.session, true
		}
		e.Groups = append(e.Groups, x)
	}
	return e
}

func (e *coldIndexDay) toDay(id int32, start float64, base int64) *coldDay {
	d := &coldDay{id: id, date: e.Date, start: start, end: AddDays(start, 1), base: base, lines: e.Lines, n: e.N, odd: e.Odd,
		misaligned: e.Misaligned, minTs: e.MinTs, maxTs: e.MaxTs, lastBySrc: e.LastBySrc, size: e.Size, mtime: e.Mtime}
	if d.lastBySrc == nil {
		d.lastBySrc = map[string]float64{}
	}
	if d.n == 0 {
		d.minTs, d.maxTs = math.Inf(1), math.Inf(-1)
	}
	for _, x := range e.Groups {
		g := &coldGroup{source: internStr("source", x.Source), via: internStr("via", x.Via), model: internStr("model", x.Model), est: x.Est,
			calls: x.Calls, input: x.Input, output: x.Output, cacheRead: x.CacheRead, cacheWrite: x.CacheWrite,
			firstTs: x.FirstTs, lastTs: x.LastTs, firstOrd: x.FirstOrd + base, priced: x.Priced, priceKey: x.PriceKey,
			cost: exactSum{p: x.Cost, posInf: x.PosInf, negInf: x.NegInf, nan: x.NaN}}
		if x.HasProvider {
			g.provider = internStrp("provider", x.Provider)
		}
		if x.HasSession {
			g.session = internStrp("session", x.Session)
		}
		d.groups = append(d.groups, g)
	}
	return d
}

func readColdIndex(dir string) map[string]*coldIndexDay {
	b, err := os.ReadFile(filepath.Join(dir, coldIndexName))
	if err != nil {
		return nil
	}
	var f coldIndexFile
	if gob.NewDecoder(bytes.NewReader(b)).Decode(&f) != nil || f.V != coldIndexV {
		return nil
	}
	out := make(map[string]*coldIndexDay, len(f.Days))
	for i := range f.Days {
		out[f.Days[i].Date] = &f.Days[i]
	}
	return out
}

// coldIndexSnapshot（持锁）：当前冷天与各天 key 的快照（coldDay 建好后不再改，只整个替换）
func (l *UsageLedger) coldIndexSnapshot() *coldIndexFile {
	byDay := map[int32][]uint64{}
	for i, h := range l.keys.h {
		if f := l.keys.f[i]; f >= 0 {
			byDay[f] = append(byDay[f], h)
		}
	}
	for h, f := range l.keys.add {
		byDay[f] = append(byDay[f], h)
	}
	out := &coldIndexFile{V: coldIndexV}
	for _, id := range l.dayIDs {
		ks := byDay[id]
		sort.Slice(ks, func(i, j int) bool { return ks[i] < ks[j] })
		out.Days = append(out.Days, l.days[id].toIndex(ks))
	}
	return out
}

// saveColdIndex：不持锁调用；写盘前再确认没被 Clear
func (l *UsageLedger) saveColdIndex() {
	l.idxMu.Lock()
	defer l.idxMu.Unlock()
	l.mu.Lock()
	epoch := l.epoch
	snap := l.coldIndexSnapshot()
	l.mu.Unlock()
	b, ok := l.encodeColdIndex(snap)
	l.mu.Lock()
	stop := epoch != l.epoch
	l.mu.Unlock()
	if ok && !stop {
		l.writeColdIndex(b)
	}
}

func (l *UsageLedger) encodeColdIndex(snap *coldIndexFile) ([]byte, bool) {
	if len(snap.Days) == 0 {
		return nil, true
	}
	var b bytes.Buffer
	if err := gob.NewEncoder(&b).Encode(snap); err != nil {
		l.warn("usage cold index failed", err.Error())
		return nil, false
	}
	return b.Bytes(), true
}

// writeColdIndex：b == nil = 没有冷天，删掉索引
func (l *UsageLedger) writeColdIndex(b []byte) {
	path := filepath.Join(l.coldDir(), coldIndexName)
	if b == nil {
		_ = os.Remove(path)
		return
	}
	if err := utils.WritePrivateFileAtomic(path, b); err != nil {
		l.warn("usage cold index failed", err.Error())
	}
}
