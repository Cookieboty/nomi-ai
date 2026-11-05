package usage

import (
	"bufio"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// 用量账本的冷数据：热窗口（最近 hotDays 天，见 hotCutoff）之外的记录不常驻内存。
//
// 磁盘：ledger.jsonl 只放热记录与最近追加的行（格式不变）；压缩时把早于热窗口的记录按本地日期挪进
// ledger-days/YYYY-MM-DD.jsonl（一天一个文件，按 (ts, ord) 排序，一个 key 只在一个文件里）。
// 内存：每天一个 coldDay——同一天里 (source, via, model, provider, session, est) 相同的规整记录合成一组，
// 记下 token / 调用数的整数和与按记录计价的费用精确和（exactSum）；外加全部冷 key 的 64 位哈希
// （coldKeys，去重用：Has / Upsert 对冷 key 仍然认得）。
// 读：整天落在查询区间里的冷天直接用分组合计；区间切开的天、有不规整记录的天、日期对不上的天，
// 从这一天的文件里流式读出记录。

const (
	defaultHotDays = 62 // ≥ 62：月预算、30 天对比的上一周期都在热窗口里
	coldDirName    = "ledger-days"
	coldKeysBatch  = 1 << 16
	maxExactTokens = 1 << 40
)

var (
	dayFileRe    = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})\.jsonl$`)
	rollupFields = [...]string{"input", "output", "cacheRead", "cacheWrite", "source", "model"}
)

// ---------------------------------------------------------------- 冷 key 集合

// coldKeys：冷 key 的哈希 → 所在日文件（YYYYMMDD）。有序数组 + 少量待并入的新增；每个 key 12 字节。
// 64 位哈希相撞（百万级 key 约 1e-7）时，新记录会被当成已有记录跳过。
type coldKeys struct {
	h    []uint64
	f    []int32 // -1 = 已删
	add  map[uint64]int32
	dead int
}

func newColdKeys() *coldKeys { return &coldKeys{add: map[uint64]int32{}} }

func (c *coldKeys) find(h uint64) int {
	i := sort.Search(len(c.h), func(i int) bool { return c.h[i] >= h })
	if i < len(c.h) && c.h[i] == h {
		return i
	}
	return -1
}

func (c *coldKeys) get(h uint64) (int32, bool) {
	if f, ok := c.add[h]; ok {
		return f, true
	}
	if i := c.find(h); i >= 0 && c.f[i] >= 0 {
		return c.f[i], true
	}
	return 0, false
}

func (c *coldKeys) set(h uint64, f int32) {
	if i := c.find(h); i >= 0 {
		if c.f[i] < 0 {
			c.dead--
		}
		c.f[i] = f
		return
	}
	c.add[h] = f
	if len(c.add) >= coldKeysBatch {
		c.merge()
	}
}

func (c *coldKeys) del(h uint64) {
	if _, ok := c.add[h]; ok {
		delete(c.add, h)
		return
	}
	if i := c.find(h); i >= 0 && c.f[i] >= 0 {
		c.f[i] = -1
		c.dead++
	}
}

func (c *coldKeys) size() int { return len(c.h) - c.dead + len(c.add) }

func (c *coldKeys) merge() {
	type kv struct {
		h uint64
		f int32
	}
	extra := make([]kv, 0, len(c.add))
	for h, f := range c.add {
		extra = append(extra, kv{h, f})
	}
	sort.Slice(extra, func(i, j int) bool { return extra[i].h < extra[j].h })
	n := len(c.h) - c.dead + len(extra)
	h := make([]uint64, 0, n)
	f := make([]int32, 0, n)
	i, j := 0, 0
	for i < len(c.h) || j < len(extra) {
		if j >= len(extra) || (i < len(c.h) && c.h[i] < extra[j].h) {
			if c.f[i] >= 0 {
				h, f = append(h, c.h[i]), append(f, c.f[i])
			}
			i++
			continue
		}
		h, f = append(h, extra[j].h), append(f, extra[j].f)
		j++
	}
	c.h, c.f, c.dead, c.add = h, f, 0, map[uint64]int32{}
}

// ---------------------------------------------------------------- 冷天与分组

type coldGroup struct {
	source, via, model string
	provider, session  *string
	est                bool

	calls, input, output, cacheRead, cacheWrite float64
	firstTs, lastTs                             float64
	firstOrd                                    int64

	priced   bool
	priceKey string // 算费用时用的价格（priceKeyOf）；和现在的价格不同 = 过期
	cost     exactSum
}

type coldDay struct {
	id         int32 // YYYYMMDD
	date       string
	start, end float64 // 这个日期的本地 0 点与次日 0 点
	base       int64   // 文件第一行的 ord（第 i 个非空行 = base+i）
	lines      int
	groups     []*coldGroup
	odd        int  // 不规整的记录数（这一天要按记录读）
	misaligned bool // 有记录不在这个日期里（换过时区）
	n          int
	minTs      float64
	maxTs      float64
	lastBySrc  map[string]float64
	size       int64 // 日文件的大小与修改时间（索引按它认）
	mtime      int64
}

func (d *coldDay) file(dir string) string { return filepath.Join(dir, d.date+".jsonl") }

func dayIDOf(date string) (int32, float64, bool) {
	m := dayFileRe.FindStringSubmatch(date + ".jsonl")
	if m == nil {
		return 0, 0, false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	dd, _ := strconv.Atoi(m[3])
	t := time.Date(y, time.Month(mo), dd, 0, 0, 0, 0, time.Local)
	if t.Year() != y || int(t.Month()) != mo || t.Day() != dd {
		return 0, 0, false
	}
	return int32(y*10000 + mo*100 + dd), timeMs(t), true
}

// rollupable：可以只留合计的记录——四项 token 是不太大的整数（求和与顺序无关），读到的字段类型都对
func rollupable(r *UsageRecord) bool {
	for k := range r.raw {
		if _, known := recFields[k]; known {
			return false
		}
	}
	if r.keys != nil { // keys == nil 时数字与字符串字段总是自有属性
		n := 0
		for _, k := range r.keys {
			switch k {
			case "input", "output", "cacheRead", "cacheWrite", "source", "model":
				n++
			}
		}
		if n < len(rollupFields) {
			return false
		}
	}
	for _, v := range [...]float64{r.Input, r.Output, r.CacheRead, r.CacheWrite} {
		if v != math.Trunc(v) || math.Abs(v) > maxExactTokens {
			return false
		}
	}
	return true
}

// priceKeys：一次计算 / 读取里 (provider, model) → 价格指纹
type priceKeys struct {
	po PriceOf
	m  map[string]string
}

func newPriceKeys(po PriceOf) *priceKeys { return &priceKeys{po: po, m: map[string]string{}} }

func (p *priceKeys) of(provider *string, model string) (string, *PriceMatch) {
	pv := ""
	if provider != nil {
		pv = *provider
	}
	if p.po == nil {
		return "\x00none", nil
	}
	m := p.po(model, pv)
	k := pv + "\x00" + model
	if s, ok := p.m[k]; ok {
		return s, m
	}
	s := ""
	if m != nil {
		b, _ := json.Marshal(m.Price)
		s = "p" + string(b)
	}
	p.m[k] = s
	return s, m
}

// buildDay：从这一天的赢家记录（已按 (ts, ord) 排好）建合计
func buildDay(id int32, date string, start float64, base int64, lines int, recs []*UsageRecord, pk *priceKeys) *coldDay {
	d := &coldDay{id: id, date: date, start: start, end: AddDays(start, 1), base: base, lines: lines,
		minTs: math.Inf(1), maxTs: math.Inf(-1), lastBySrc: map[string]float64{}}
	type gk struct {
		source, via, model, provider, session string
		hasProv, hasSess, est                 bool
	}
	idx := map[gk]*coldGroup{}
	for _, r := range recs {
		d.n++
		d.minTs = math.Min(d.minTs, r.Ts)
		d.maxTs = math.Max(d.maxTs, r.Ts)
		if v, ok := d.lastBySrc[r.Source]; !ok || r.Ts > v {
			d.lastBySrc[r.Source] = r.Ts
		}
		if r.Ts < d.start || r.Ts >= d.end {
			d.misaligned = true
		}
		if !rollupable(r) {
			d.odd++
			continue
		}
		est := r.Est != nil && *r.Est
		k := gk{source: r.Source, via: r.Via, model: r.Model, hasProv: r.Provider != nil, hasSess: r.Session != nil, est: est}
		if r.Provider != nil {
			k.provider = *r.Provider
		}
		if r.Session != nil {
			k.session = *r.Session
		}
		g := idx[k]
		if g == nil {
			g = &coldGroup{source: r.Source, via: r.Via, model: r.Model, provider: r.Provider, session: r.Session, est: est,
				firstTs: r.Ts, lastTs: r.Ts, firstOrd: r.ord}
			g.priceKey, _ = pk.of(r.Provider, r.Model)
			idx[k] = g
			d.groups = append(d.groups, g)
		}
		g.calls++
		g.input += r.Input
		g.output += r.Output
		g.cacheRead += r.CacheRead
		g.cacheWrite += r.CacheWrite
		if r.Ts < g.firstTs || (r.Ts == g.firstTs && r.ord < g.firstOrd) {
			g.firstTs, g.firstOrd = r.Ts, r.ord
		}
		g.lastTs = math.Max(g.lastTs, r.Ts)
		key, m := pk.of(r.Provider, r.Model)
		if key != g.priceKey {
			g.priceKey = "\x00mixed" // 价格在建的过程中变了：下次读时重算
		}
		if m != nil {
			g.priced = true
			g.cost.add(CostUsd(RecordCost(r), m.Price))
		}
	}
	return d
}

// ---------------------------------------------------------------- 日文件读写

func (l *UsageLedger) coldDir() string { return filepath.Join(l.d.Root, coldDirName) }

func (l *UsageLedger) hotDays() int {
	if l.d.HotDays != nil {
		return *l.d.HotDays
	}
	return defaultHotDays
}

// hotCutoff：热窗口的起点（本地 0 点）；更早的记录在压缩时挪进日文件
func (l *UsageLedger) hotCutoff() float64 { return AddDays(StartOfDay(l.now()), -l.hotDays()) }

// readDayFile：读一个日文件；同一个 key 出现多次时取最后的值、保留第一次的位置（同 Map.set）
func readDayFile(file string, base int64) ([]*UsageRecord, int, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 64*1024*1024)
	var out []*UsageRecord
	var seen map[string]int
	lines := 0
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		ord := base + int64(lines)
		lines++
		r := parseLine(string(line))
		if r == nil {
			continue
		}
		r.ord = ord
		if seen == nil {
			seen = map[string]int{}
		}
		if i, ok := seen[r.Key]; ok {
			r.ord = out[i].ord
			out[i] = r
			continue
		}
		seen[r.Key] = len(out)
		out = append(out, r)
	}
	return out, lines, sc.Err()
}

// coldWinner：这一行是不是这个 key 的有效版本（ledger.jsonl 里有同 key 的记录时以那条为准）
func (l *UsageLedger) coldWinner(r *UsageRecord, id int32) bool {
	if l.recs.get(r.Key) != nil {
		return false
	}
	f, ok := l.keys.get(coldHash(r.Key))
	return ok && f == id
}

// dayRecords：这一天在保留期内的有效记录（按 (ts, ord)）
func (l *UsageLedger) dayRecords(d *coldDay) []*UsageRecord {
	recs, _, err := readDayFile(d.file(l.coldDir()), d.base)
	if err != nil {
		l.warn("usage cold read failed", err.Error())
		return nil
	}
	out := recs[:0]
	for _, r := range recs {
		if r.Ts >= l.coldPrune && l.coldWinner(r, d.id) {
			out = append(out, r)
		}
	}
	sortByTs(out)
	return out
}

// loadDays：载入时读日文件（索引对得上的直接用索引里的合计与 key，否则逐行解析），只建合计与冷 key，不留记录。
// m 是 ledger.jsonl 里的记录：同 key 以 m 为准。返回 dirty = 索引要重写。
func loadDays(dir string, m *recMap, pk *priceKeys, warn func(string, any)) (days map[int32]*coldDay, ids []int32, keys *coldKeys, seq int64, ok, dirty bool) {
	days = map[int32]*coldDay{}
	keys = newColdKeys()
	ok = true
	ents, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		warn("usage cold list failed", err.Error())
		return days, nil, keys, 0, false, false
	}
	type ent struct {
		id          int32
		date        string
		start       float64
		size, mtime int64
	}
	var list []ent
	for _, e := range ents {
		name := e.Name()
		if strings.Contains(name, ".tmp") {
			_ = os.Remove(filepath.Join(dir, name))
			continue
		}
		if !dayFileRe.MatchString(name) {
			continue
		}
		date := strings.TrimSuffix(name, ".jsonl")
		id, start, valid := dayIDOf(date)
		fi, err := e.Info()
		if !valid || err != nil {
			continue
		}
		list = append(list, ent{id, date, start, fi.Size(), fi.ModTime().UnixNano()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].id < list[j].id })
	idx := readColdIndex(dir)
	if len(list) > 0 && idx == nil {
		dirty = true
	}
	type pos struct {
		h  uint64
		id int32
	}
	var all []pos
	redo := map[int32]bool{}
	parse := func(e ent, base int64, skip func(*UsageRecord) bool) (*coldDay, []*UsageRecord, int) {
		recs, lines, err := readDayFile(filepath.Join(dir, e.date+".jsonl"), base)
		if err != nil {
			warn("usage cold load failed", err.Error())
			ok = false
		}
		kept := recs[:0]
		for _, r := range recs {
			if !skip(r) {
				kept = append(kept, r)
			}
		}
		sortByTs(kept)
		d := buildDay(e.id, e.date, e.start, base, lines, kept, pk)
		d.size, d.mtime = e.size, e.mtime
		return d, kept, lines
	}
	inM := func(r *UsageRecord) bool { return m.get(r.Key) != nil }
	for _, e := range list {
		if x := idx[e.date]; x != nil && x.Size == e.size && x.Mtime == e.mtime {
			days[e.id] = x.toDay(e.id, e.start, seq)
			seq += int64(x.Lines)
			for _, h := range x.Keys {
				all = append(all, pos{h, e.id})
			}
			continue
		}
		dirty = true
		d, kept, lines := parse(e, seq, inM)
		seq += int64(lines)
		days[e.id] = d
		for _, r := range kept {
			all = append(all, pos{coldHash(r.Key), e.id})
		}
	}
	// 同一个 key 在两个日文件里（不该有）：后读到的为准，两天都重建
	sort.SliceStable(all, func(i, j int) bool { return all[i].h < all[j].h })
	keys.h = make([]uint64, 0, len(all))
	keys.f = make([]int32, 0, len(all))
	for i := 0; i < len(all); i++ {
		if i+1 < len(all) && all[i+1].h == all[i].h {
			redo[all[i].id], redo[all[i+1].id] = true, true
			continue
		}
		keys.h = append(keys.h, all[i].h)
		keys.f = append(keys.f, all[i].id)
	}
	// ledger.jsonl 里也有的 key（压缩到一半崩溃、旧版本重新扫描）：以 ledger.jsonl 为准，那一天重建
	m.each(func(k string, _ *UsageRecord) bool {
		h := coldHash(k)
		if f, hit := keys.get(h); hit {
			keys.del(h)
			redo[f] = true
		}
		return true
	})
	for id := range days {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, e := range list {
		if !redo[e.id] {
			continue
		}
		dirty = true
		id := e.id
		d, _, _ := parse(e, days[id].base, func(r *UsageRecord) bool {
			f, hit := keys.get(coldHash(r.Key))
			return !hit || f != id || inM(r)
		})
		days[id] = d
	}
	return days, ids, keys, seq, ok, dirty
}

func (l *UsageLedger) priceKeysForBuild() *priceKeys {
	if l.d.PriceOf != nil {
		return newPriceKeys(l.d.PriceOf())
	}
	return newPriceKeys(l.lastPriceOf)
}

func (l *UsageLedger) setDay(d *coldDay) {
	if _, ok := l.days[d.id]; !ok {
		i := sort.Search(len(l.dayIDs), func(i int) bool { return l.dayIDs[i] >= d.id })
		l.dayIDs = append(l.dayIDs, 0)
		copy(l.dayIDs[i+1:], l.dayIDs[i:])
		l.dayIDs[i] = d.id
	}
	l.days[d.id] = d
}

func (l *UsageLedger) dropDay(id int32) {
	if _, ok := l.days[id]; !ok {
		return
	}
	delete(l.days, id)
	i := sort.Search(len(l.dayIDs), func(i int) bool { return l.dayIDs[i] >= id })
	l.dayIDs = append(l.dayIDs[:i], l.dayIDs[i+1:]...)
}

func (l *UsageLedger) coldSize() int { return l.keys.size() }

// ---------------------------------------------------------------- 读

func (l *UsageLedger) hotRange(from, to float64) []*UsageRecord {
	arr := l.snapshot()
	i := lowerBound(arr, from)
	j := i
	for j < len(arr) && arr[j].Ts < to {
		j++
	}
	return arr[i:j]
}

// Rows：[from, to) 的聚合行（按 (ts, ord)）。整天在区间内的冷天给分组合计，其余给记录；
// 与 [recFrom, ∞) 相交的冷天也给记录（按小时分桶时用）。冷天的费用按建合计时的价格；价格变了会在后台重算，
// 重算完 Version() 变、OnChanged 回调——在那之前读到的是旧价格的费用（token 与调用数不受影响）。
func (l *UsageLedger) Rows(from, to, recFrom float64, priceOf PriceOf) []aggRow {
	l.mu.Lock()
	defer l.mu.Unlock()
	var cold []aggRow
	stale := false
	pk := newPriceKeys(priceOf)
	// 区间里有不规整的记录（字符串 / 小数 token 等，按 JS `+` 逐条相加的结果依赖顺序）：整段都给记录
	odd := false
	for _, id := range l.dayIDs {
		d := l.days[id]
		if d.odd > 0 && d.maxTs >= from && d.minTs < to && d.maxTs >= l.coldPrune {
			odd = true
			break
		}
	}
	if !odd && len(l.dayIDs) > 0 {
		odd = l.hotHasOdd(from, to)
	}
	for _, id := range l.dayIDs {
		d := l.days[id]
		if d.n == 0 || d.maxTs < from || d.minTs >= to || d.maxTs < l.coldPrune {
			continue
		}
		whole := !odd && d.minTs >= from && d.maxTs < to && !d.misaligned && d.minTs >= l.coldPrune && d.maxTs < recFrom
		if whole {
			for _, g := range d.groups {
				cold = append(cold, aggRow{g: g})
				if k, _ := pk.of(g.provider, g.model); k != g.priceKey {
					stale = true
				}
			}
			continue
		}
		for _, r := range l.dayRecords(d) {
			if r.Ts >= from && r.Ts < to {
				cold = append(cold, aggRow{r: r})
			}
		}
	}
	if stale {
		l.kickRecompute(priceOf)
	}
	hot := l.hotRange(from, to)
	if len(cold) == 0 {
		return recRows(hot)
	}
	sortRows(cold)
	out := make([]aggRow, 0, len(cold)+len(hot))
	i := 0
	for _, r := range hot {
		w := aggRow{r: r}
		for i < len(cold) && rowLess(cold[i], w) {
			out = append(out, cold[i])
			i++
		}
		out = append(out, w)
	}
	return append(out, cold[i:]...)
}

// hotHasOdd（持锁）：内存里 [from, to) 有不规整的记录（按版本缓存不规整记录的 ts）
func (l *UsageLedger) hotHasOdd(from, to float64) bool {
	if l.oddVer != l.ver || l.oddTs == nil {
		l.oddTs = []float64{}
		for _, r := range l.snapshot() {
			if !rollupable(r) {
				l.oddTs = append(l.oddTs, r.Ts)
			}
		}
		l.oddVer = l.ver
	}
	for _, ts := range l.oddTs {
		if ts >= from && ts < to {
			return true
		}
	}
	return false
}

// coldRange：冷数据里 [from, to) 的记录（从日文件读）
func (l *UsageLedger) coldRange(from, to float64) []*UsageRecord {
	var out []*UsageRecord
	for _, id := range l.dayIDs {
		d := l.days[id]
		if d.n == 0 || d.maxTs < from || d.minTs >= to || d.maxTs < l.coldPrune {
			continue
		}
		for _, r := range l.dayRecords(d) {
			if r.Ts >= from && r.Ts < to {
				out = append(out, r)
			}
		}
	}
	return out
}

func mergeByTs(a, b []*UsageRecord) []*UsageRecord {
	if len(a) == 0 {
		return append([]*UsageRecord{}, b...)
	}
	sortByTs(a)
	out := make([]*UsageRecord, 0, len(a)+len(b))
	i := 0
	for _, r := range b {
		for i < len(a) && (a[i].Ts < r.Ts || (a[i].Ts == r.Ts && a[i].ord < r.ord)) {
			out = append(out, a[i])
			i++
		}
		out = append(out, r)
	}
	return append(out, a[i:]...)
}

// ---------------------------------------------------------------- 压缩：挪进日文件、保留期、重算

// compactCold：先按保留期裁冷天、把换过时区的冷天里不属于它的记录挪回内存，再把热窗口外的内存记录写进日文件。
// 每个日文件一次加锁处理（不长时间挡住读写）；返回 false = 中途被 Clear / Close 打断。
func (l *UsageLedger) compactCold(epoch int) bool {
	l.mu.Lock()
	edits := l.coldEdits
	defer func() {
		l.mu.Lock()
		changed := l.coldEdits != edits
		l.mu.Unlock()
		if changed {
			l.saveColdIndex()
		}
	}()
	var work []int32
	for _, id := range l.dayIDs {
		if d := l.days[id]; d.minTs < l.coldPrune || d.misaligned {
			work = append(work, id)
		}
	}
	l.mu.Unlock()
	for _, id := range work {
		l.mu.Lock()
		if l.closed || epoch != l.epoch {
			l.mu.Unlock()
			return false
		}
		if d := l.days[id]; d != nil {
			l.rewriteDay(id, d.date, d.start, nil)
		}
		l.mu.Unlock()
	}
	l.mu.Lock()
	cut := l.hotCutoff()
	byDate := map[string][]*UsageRecord{}
	var dates []string
	for _, r := range l.snapshot() {
		if r.Ts >= cut {
			break
		}
		k := DateKey(r.Ts)
		if _, ok := byDate[k]; !ok {
			dates = append(dates, k)
		}
		byDate[k] = append(byDate[k], r)
	}
	l.mu.Unlock()
	sort.Strings(dates)
	for _, date := range dates {
		id, start, ok := dayIDOf(date)
		if !ok {
			continue
		}
		l.mu.Lock()
		if l.closed || epoch != l.epoch {
			l.mu.Unlock()
			return false
		}
		l.rewriteDay(id, date, start, byDate[date])
		l.mu.Unlock()
	}
	return true
}

// rewriteDay（持锁）：日文件 = 现有有效记录（去掉保留期外的、挪走日期不符的）+ add 里仍在内存且没改过的记录
func (l *UsageLedger) rewriteDay(id int32, date string, start float64, add []*UsageRecord) {
	if len(add) > 0 {
		// 先把内存里的新版本落盘：日文件写好、ledger.jsonl 还没重写时崩溃，载入会以 ledger.jsonl 为准
		if err := l.appendDirty(); err != nil {
			l.settle(err)
			return
		}
	}
	dir := l.coldDir()
	var keep, back, gone []*UsageRecord
	if d := l.days[id]; d != nil {
		recs, _, err := readDayFile(d.file(dir), d.base)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			l.warn("usage cold read failed", err.Error())
			return
		}
		for _, r := range recs {
			switch {
			case !l.coldWinner(r, id):
			case r.Ts < l.coldPrune:
				gone = append(gone, r)
			case DateKey(r.Ts) != date:
				back = append(back, r)
			default:
				keep = append(keep, r)
			}
		}
	}
	if len(back) > 0 {
		// 日期不符的记录回到内存（并追加进 ledger.jsonl），之后的压缩按现在的时区放进对的日文件
		for _, r := range back {
			r.ord = l.seq
			l.seq++
			l.recs.set(r.Key, r)
			l.keys.del(coldHash(r.Key))
			l.dirty.add(r.Key)
			l.lines++
		}
		l.sorted, l.routeSorted = nil, nil
		if err := l.appendDirty(); err != nil {
			l.settle(err)
			return
		}
	}
	var moved []*UsageRecord
	for _, r := range add {
		if l.recs.get(r.Key) == r {
			moved = append(moved, r)
		}
	}
	sortByTs(keep)
	sortByTs(moved)
	merged := mergeByTs(moved, keep)
	if len(merged) == 0 {
		if err := os.Remove(filepath.Join(dir, date+".jsonl")); err != nil && !errors.Is(err, fs.ErrNotExist) {
			l.warn("usage cold write failed", err.Error())
			return
		}
	} else {
		var b strings.Builder
		for _, r := range merged {
			b.WriteString(stringifyRec(r))
			b.WriteByte('\n')
		}
		_ = os.MkdirAll(dir, 0o700)
		if err := utils.WritePrivateFileAtomic(filepath.Join(dir, date+".jsonl"), []byte(b.String())); err != nil {
			l.warn("usage cold write failed", err.Error())
			return
		}
	}
	var size, mtime int64
	if fi, err := os.Stat(filepath.Join(dir, date+".jsonl")); err == nil {
		size, mtime = fi.Size(), fi.ModTime().UnixNano()
	}
	for _, r := range gone {
		l.keys.del(coldHash(r.Key))
	}
	for _, r := range moved {
		l.recs.del(r.Key)
		l.keys.set(coldHash(r.Key), id)
	}
	if len(moved) > 0 {
		l.sorted, l.routeSorted = nil, nil
	}
	base := l.seq
	for i, r := range merged {
		r.ord = base + int64(i)
	}
	l.seq += int64(len(merged))
	if len(merged) == 0 {
		l.dropDay(id)
	} else {
		nd := buildDay(id, date, start, base, len(merged), merged, l.priceKeysForBuild())
		nd.size, nd.mtime = size, mtime
		l.setDay(nd)
	}
	l.coldEdits++
	l.ver++
}

// needColdWork（持锁）：内存里有热窗口外的记录，或冷天要按保留期裁
func (l *UsageLedger) needColdWork() bool {
	if arr := l.snapshot(); len(arr) > 0 && arr[0].Ts < l.hotCutoff() {
		return true
	}
	for _, id := range l.dayIDs {
		if d := l.days[id]; d.minTs < l.coldPrune || d.misaligned {
			return true
		}
	}
	return false
}

// kickRecompute（持锁）：后台按 priceOf 重算价格过期的冷天
func (l *UsageLedger) kickRecompute(priceOf PriceOf) {
	l.lastPriceOf = priceOf
	if l.rcRunning {
		l.rcAgain = true
		return
	}
	l.rcRunning = true
	l.rcWG.Add(1)
	go l.recomputeLoop()
}

func (l *UsageLedger) recomputeLoop() {
	defer l.rcWG.Done()
	for {
		l.mu.Lock()
		po := l.lastPriceOf
		l.rcAgain = false
		ids := append([]int32(nil), l.dayIDs...)
		epoch := l.epoch
		l.mu.Unlock()
		pk := newPriceKeys(po)
		changed := false
		for _, id := range ids {
			l.mu.Lock()
			if l.closed || epoch != l.epoch {
				l.rcRunning = false
				l.mu.Unlock()
				return
			}
			if d := l.days[id]; d != nil && dayStale(d, pk) {
				recs := l.dayRecords(d)
				nd := buildDay(d.id, d.date, d.start, d.base, d.lines, recs, pk)
				nd.size, nd.mtime = d.size, d.mtime
				l.setDay(nd)
				changed = true
			}
			l.mu.Unlock()
		}
		l.mu.Lock()
		if changed {
			l.ver++
		}
		again := l.rcAgain
		if !again {
			l.rcRunning = false
		}
		cb := l.d.OnChanged
		l.mu.Unlock()
		if changed {
			l.saveColdIndex()
			if cb != nil {
				cb()
			}
		}
		if !again {
			return
		}
	}
}

func dayStale(d *coldDay, pk *priceKeys) bool {
	for _, g := range d.groups {
		if k, _ := pk.of(g.provider, g.model); k != g.priceKey {
			return true
		}
	}
	return false
}

// waitRecompute：测试用，等后台重算结束
func (l *UsageLedger) waitRecompute() { l.rcWG.Wait() }
