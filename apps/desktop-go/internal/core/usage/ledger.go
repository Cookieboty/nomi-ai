package usage

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// 对应 UsageLedger.ts

type Retention = string

var RetentionMs = map[string]float64{
	"90d":     90 * dayMs,
	"1y":      365 * dayMs,
	"forever": math.Inf(1),
}

// FileCursor：state 保持为原始 JSON（各解析器自己的续读状态）
type FileCursor struct {
	Offset  float64        `json:"offset"`
	Size    float64        `json:"size"`
	MtimeMs float64        `json:"mtimeMs"`
	Dev     *float64       `json:"dev,omitempty"`
	Ino     *float64       `json:"ino,omitempty"`
	Fp      *string        `json:"fp,omitempty"`
	FpLen   *float64       `json:"fpLen,omitempty"`
	State   map[string]any `json:"state,omitempty"`
}

type Logger interface {
	Info(m string, d any)
	Warn(m string, d any)
}

const (
	syncLoadMaxBytes = 1024 * 1024
	loadChunkBytes   = 1024 * 1024
	compactBatch     = 4000
	routeSlackMs     = 15_000
	promptTolRel     = 0.1
	promptTolAbs     = 16
)

var ledgerTmpSeq int64

func cloneRec(r *UsageRecord) *UsageRecord { c := *r; return &c }

func mergeRecord(prev, r *UsageRecord) *UsageRecord {
	model := prev.Model
	if r.Model != "" && r.Model != "unknown" {
		model = r.Model
	}
	m := spreadRec(prev, r)
	m.Model = model
	m.Input = math.Max(prev.Input, r.Input)
	m.Output = math.Max(prev.Output, r.Output)
	m.CacheRead = math.Max(prev.CacheRead, r.CacheRead)
	m.CacheWrite = math.Max(prev.CacheWrite, r.CacheWrite)
	m.Ts = math.Min(prev.Ts, r.Ts)
	w1h := math.Max(or0(prev.CacheWrite1h, 0), or0(r.CacheWrite1h, 0))
	if w1h != 0 && !math.IsNaN(w1h) {
		m.CacheWrite1h = f64p(w1h)
	} else {
		m.CacheWrite1h = nil
	}
	if truthyB(prev.Fast) || truthyB(r.Fast) {
		m.Fast = boolp(true)
	} else {
		m.Fast = nil
	}
	if m.Input == prev.Input && m.Output == prev.Output && m.CacheRead == prev.CacheRead &&
		m.CacheWrite == prev.CacheWrite && or0(m.CacheWrite1h, 0) == or0(prev.CacheWrite1h, 0) &&
		truthyB(m.Fast) == truthyB(prev.Fast) && m.Model == prev.Model {
		return nil
	}
	return m
}

func truthyB(b *bool) bool { return b != nil && *b }

// spreadRec = { ...prev, ...r }：r 里出现（非 undefined）的可选字段覆盖 prev
func spreadRec(prev, r *UsageRecord) *UsageRecord {
	m := cloneRec(r)
	if m.Dur == nil {
		m.Dur = prev.Dur
	}
	if m.Provider == nil {
		m.Provider = prev.Provider
	}
	if m.CacheWrite1h == nil {
		m.CacheWrite1h = prev.CacheWrite1h
	}
	if m.Fast == nil {
		m.Fast = prev.Fast
	}
	if m.Rid == nil {
		m.Rid = prev.Rid
	}
	if m.LogKey == nil {
		m.LogKey = prev.LogKey
	}
	if m.Session == nil {
		m.Session = prev.Session
	}
	if m.Project == nil {
		m.Project = prev.Project
	}
	if m.Est == nil {
		m.Est = prev.Est
	}
	return m
}

// parseLine：key 是字符串且 ts 是数字才收
func parseLine(line string) *UsageRecord {
	if line == "" {
		return nil
	}
	var probe struct {
		Key any `json:"key"`
		Ts  any `json:"ts"`
	}
	if json.Unmarshal([]byte(line), &probe) != nil {
		return nil
	}
	if _, ok := probe.Key.(string); !ok {
		return nil
	}
	if _, ok := probe.Ts.(float64); !ok {
		return nil
	}
	var r UsageRecord
	if json.Unmarshal([]byte(line), &r) != nil {
		return nil
	}
	return &r
}

type RouteHint struct {
	Key     string
	Session *string
	Prompt  float64
	Output  float64
}

func sameRequestID(logKey, rid string) bool {
	return logKey == rid || strings.HasSuffix(logKey, ":"+rid)
}

type LedgerDeps struct {
	Root             string
	Logger           Logger
	FlushMs          *float64
	Now              func() float64
	OnPersistChange  func(degraded bool)
	SyncLoadMaxBytes *int64
	OnLoaded         func()
}

// recMap：保持插入顺序的 Map（JS Map 迭代序）
type recMap struct {
	m     map[string]*UsageRecord
	order []string
	idx   map[string]int
	dead  int
}

func newRecMap() *recMap { return &recMap{m: map[string]*UsageRecord{}, idx: map[string]int{}} }

func (rm *recMap) get(k string) *UsageRecord { return rm.m[k] }
func (rm *recMap) set(k string, r *UsageRecord) {
	if _, ok := rm.m[k]; !ok {
		rm.idx[k] = len(rm.order)
		rm.order = append(rm.order, k)
	}
	rm.m[k] = r
}
func (rm *recMap) del(k string) {
	if _, ok := rm.m[k]; !ok {
		return
	}
	delete(rm.m, k)
	rm.order[rm.idx[k]] = "\x00"
	delete(rm.idx, k)
	rm.dead++
	if rm.dead > 1024 && rm.dead > len(rm.order)/2 {
		rm.compactOrder()
	}
}
func (rm *recMap) compactOrder() {
	o := make([]string, 0, len(rm.m))
	for _, k := range rm.order {
		if _, ok := rm.m[k]; ok && k != "\x00" {
			rm.idx[k] = len(o)
			o = append(o, k)
		}
	}
	rm.order, rm.dead = o, 0
}
func (rm *recMap) size() int { return len(rm.m) }
func (rm *recMap) each(fn func(k string, r *UsageRecord) bool) {
	for _, k := range rm.order {
		if k == "\x00" {
			continue
		}
		r, ok := rm.m[k]
		if !ok {
			continue
		}
		if !fn(k, r) {
			return
		}
	}
}
func (rm *recMap) clear() { *rm = *newRecMap() }

// orderedSet：插入顺序的 Set<string>
type orderedSet struct {
	m     map[string]bool
	order []string
}

func newOrderedSet() *orderedSet { return &orderedSet{m: map[string]bool{}} }
func (s *orderedSet) add(k string) {
	if !s.m[k] {
		s.m[k] = true
		s.order = append(s.order, k)
	}
}
func (s *orderedSet) del(k string)      { delete(s.m, k) }
func (s *orderedSet) has(k string) bool { return s.m[k] }
func (s *orderedSet) size() int         { return len(s.m) }
func (s *orderedSet) keys() []string {
	out := make([]string, 0, len(s.m))
	seen := map[string]bool{}
	for _, k := range s.order {
		if s.m[k] && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	s.order = out
	return append([]string(nil), out...)
}

// cursorMap：保持键顺序的游标表（Object.keys 顺序）
type cursorMap struct {
	m     map[string]*FileCursor
	order []string
}

func newCursorMap() *cursorMap { return &cursorMap{m: map[string]*FileCursor{}} }
func (c *cursorMap) set(k string, v *FileCursor) {
	if _, ok := c.m[k]; !ok {
		c.order = append(c.order, k)
	}
	c.m[k] = v
}
func (c *cursorMap) del(k string) {
	if _, ok := c.m[k]; !ok {
		return
	}
	delete(c.m, k)
	for i, x := range c.order {
		if x == k {
			c.order = append(c.order[:i:i], c.order[i+1:]...)
			break
		}
	}
}
func (c *cursorMap) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range c.order {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		vb, err := marshalNoEscape(c.m[k])
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// parseCursors：JSON.parse 后 c && typeof c === 'object'（数组也算，同 Node）
func parseCursors(b []byte) (*cursorMap, bool) {
	dec := json.NewDecoder(strings.NewReader(string(b)))
	t, err := dec.Token()
	if err != nil {
		return nil, false
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		if d, ok := t.(json.Delim); ok && d == '[' {
			return newCursorMap(), true
		}
		return nil, false
	}
	cm := newCursorMap()
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, false
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, false
		}
		var fc FileCursor
		_ = json.Unmarshal(raw, &fc)
		cm.set(kt.(string), &fc)
	}
	return cm, true
}

// marshalNoEscape：JSON.stringify 口径（不转义 <>&）
func marshalNoEscape(v any) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSuffix(b.String(), "\n")), nil
}

func stringifyRec(r *UsageRecord) string {
	b, _ := marshalNoEscape(r)
	return string(b)
}

type UsageLedger struct {
	mu                sync.Mutex
	d                 LedgerDeps
	file              string
	cursorFile        string
	recs              *recMap
	sorted            []*UsageRecord
	routeSorted       []*UsageRecord
	cursors           *cursorMap
	dirty             *orderedSet
	appendTainted     bool
	degraded          bool
	flushTimer        *time.Timer
	flushGen          int
	cursorDirty       bool
	lines             int
	ver               int
	epoch             int
	loaded            bool
	ready             chan struct{}
	pendingPrune      string
	droppedDuringLoad *orderedSet
	noCompact         bool
	closed            bool
	compactRunning    *compactJob
	compactQueued     *compactJob
	cursorGen         int
	cursorSyncGen     int
	cursorWriting     bool
	cursorWriteMu     sync.Mutex
}

type compactJob struct{ done chan struct{} }

func NewUsageLedger(d LedgerDeps) *UsageLedger {
	l := &UsageLedger{d: d, recs: newRecMap(), cursors: newCursorMap(), dirty: newOrderedSet(), droppedDuringLoad: newOrderedSet()}
	_ = os.MkdirAll(d.Root, 0o777)
	l.file = filepath.Join(d.Root, "ledger.jsonl")
	l.cursorFile = filepath.Join(d.Root, "cursors.json")
	var size int64
	if fi, err := os.Stat(l.file); err == nil {
		size = fi.Size()
	}
	max := int64(syncLoadMaxBytes)
	if d.SyncLoadMaxBytes != nil {
		max = *d.SyncLoadMaxBytes
	}
	l.ready = make(chan struct{})
	if size <= max {
		close(l.ready)
		l.mu.Lock()
		l.loadSync()
		l.mu.Unlock()
	} else {
		go l.loadAsync(size)
	}
	return l
}

func (l *UsageLedger) now() float64 {
	if l.d.Now != nil {
		return l.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (l *UsageLedger) warn(m string, d any) {
	if l.d.Logger != nil {
		l.d.Logger.Warn(m, d)
	}
}

func (l *UsageLedger) loadSync() {
	text := ""
	if b, err := os.ReadFile(l.file); err == nil {
		text = string(b)
	} else if !errors.Is(err, fs.ErrNotExist) {
		l.noCompact = true
	}
	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		l.lines++
		if r := parseLine(line); r != nil {
			l.recs.set(r.Key, r)
		}
	}
	if b, err := os.ReadFile(l.cursorFile); err == nil {
		if c, ok := parseCursors(b); ok {
			l.cursors = c
		}
	}
	l.loaded = true
	if l.lines > 1000 && l.lines > l.recs.size()*2 {
		l.compactLocked()
	}
}

func (l *UsageLedger) loadAsync(size int64) {
	t0 := time.Now()
	l.mu.Lock()
	epoch := l.epoch
	l.mu.Unlock()
	disk := newRecMap()
	lines := 0
	failed := false
	f, err := os.Open(l.file)
	if err == nil {
		rd := bufio.NewReaderSize(io.LimitReader(f, size), loadChunkBytes)
		rest := ""
		buf := make([]byte, loadChunkBytes)
		for {
			n, rerr := rd.Read(buf)
			if n > 0 {
				text := rest + string(buf[:n])
				from := 0
				for {
					nl := strings.IndexByte(text[from:], '\n')
					if nl < 0 {
						break
					}
					line := text[from : from+nl]
					from += nl + 1
					if line == "" {
						continue
					}
					lines++
					if r := parseLine(line); r != nil {
						disk.set(r.Key, r)
					}
				}
				rest = text[from:]
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				err = rerr
				break
			}
		}
		f.Close()
		if err == nil && rest != "" {
			lines++
			if r := parseLine(rest); r != nil {
				disk.set(r.Key, r)
			}
		}
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		failed = true
		l.warn("usage ledger load failed", err.Error())
	}
	diskCursors := newCursorMap()
	if b, err := os.ReadFile(l.cursorFile); err == nil {
		if c, ok := parseCursors(b); ok {
			diskCursors = c
		}
	}
	l.mu.Lock()
	if failed {
		l.noCompact = true
		disk.clear()
		lines = 0
	}
	if epoch != l.epoch {
		disk.clear()
		lines = 0
	}
	cb := l.adopt(disk, lines, diskCursors)
	recs := l.recs.size()
	l.mu.Unlock()
	if l.d.Logger != nil {
		l.d.Logger.Info("usage ledger loaded", map[string]any{"records": recs, "lines": lines, "ms": time.Since(t0).Milliseconds()})
	}
	if cb != nil {
		cb()
	}
}

func (l *UsageLedger) adopt(disk *recMap, lines int, diskCursors *cursorMap) func() {
	l.recs.each(func(k string, r *UsageRecord) bool {
		prev := disk.get(k)
		if prev == nil {
			disk.set(k, r)
			return true
		}
		if m := mergeRecord(prev, r); m != nil {
			disk.set(k, m)
		} else {
			disk.set(k, prev)
		}
		l.dirty.add(k)
		return true
	})
	l.recs = disk
	l.lines += lines
	l.sorted = nil
	l.routeSorted = nil
	l.ver++
	for _, p := range l.droppedDuringLoad.keys() {
		diskCursors.del(p)
	}
	l.droppedDuringLoad = newOrderedSet()
	if len(l.cursors.order) > 0 {
		merged := newCursorMap()
		for _, k := range diskCursors.order {
			merged.set(k, diskCursors.m[k])
		}
		for _, k := range l.cursors.order {
			merged.set(k, l.cursors.m[k])
		}
		l.cursors = merged
		l.cursorGen++
	} else {
		l.cursors = diskCursors
	}
	l.loaded = true
	close(l.ready)
	pruned := false
	if l.pendingPrune != "" {
		r := l.pendingPrune
		l.pendingPrune = ""
		pruned = l.pruneLocked(r) > 0
	}
	if !pruned && l.lines > 1000 && l.lines > l.recs.size()*2 {
		l.compactLocked()
	}
	if l.dirty.size() > 0 || l.cursorDirty {
		l.scheduleFlush()
	}
	return l.d.OnLoaded
}

// WhenReady：磁盘内容已全部载入后返回
func (l *UsageLedger) WhenReady() { <-l.ready }

func (l *UsageLedger) IsLoaded() bool { l.mu.Lock(); defer l.mu.Unlock(); return l.loaded }

func (l *UsageLedger) Size() int { l.mu.Lock(); defer l.mu.Unlock(); return l.recs.size() }

func (l *UsageLedger) Upsert(r *UsageRecord) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	prev := l.recs.get(r.Key)
	if prev != nil {
		m := mergeRecord(prev, r)
		if m == nil {
			return false
		}
		r = m
	} else {
		r = cloneRec(r)
	}
	if r.Via == "route" || (prev != nil && prev.Via == "route") {
		l.routeSorted = nil
	}
	l.recs.set(r.Key, r)
	l.placeInSorted(prev, r)
	l.ver++
	l.dirty.add(r.Key)
	l.lines++
	l.scheduleFlush()
	return true
}

func (l *UsageLedger) Version() int { l.mu.Lock(); defer l.mu.Unlock(); return l.ver }

type AttributePatch struct {
	Session      string
	Project      string
	CacheWrite1h *float64
	Fast         bool
	LogKey       string
}

func eqStrP(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
func eqF64P(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
func eqBoolP(a, b *bool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func (l *UsageLedger) Attribute(key string, p AttributePatch) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	prev := l.recs.get(key)
	if prev == nil {
		return false
	}
	next := cloneRec(prev)
	if !nonEmpty(prev.Session) && p.Session != "" {
		next.Session = strp(p.Session)
	}
	if !nonEmpty(prev.Project) && p.Project != "" {
		next.Project = strp(p.Project)
	}
	w1h := math.Min(math.Max(or0(prev.CacheWrite1h, 0), or0(p.CacheWrite1h, 0)), prev.CacheWrite)
	if w1h > or0(prev.CacheWrite1h, 0) {
		next.CacheWrite1h = f64p(w1h)
	}
	if p.Fast && !truthyB(prev.Fast) {
		next.Fast = boolp(true)
	}
	if p.LogKey != "" && !nonEmpty(prev.LogKey) {
		next.LogKey = strp(p.LogKey)
	}
	if eqStrP(next.Session, prev.Session) && eqStrP(next.Project, prev.Project) && eqF64P(next.CacheWrite1h, prev.CacheWrite1h) &&
		eqBoolP(next.Fast, prev.Fast) && eqStrP(next.LogKey, prev.LogKey) {
		return false
	}
	if prev.Via == "route" {
		l.routeSorted = nil
	}
	l.recs.set(key, next)
	l.placeInSorted(prev, next)
	l.ver++
	l.dirty.add(key)
	l.lines++
	l.scheduleFlush()
	return true
}

func (l *UsageLedger) Has(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.recs.get(key) != nil
}

func (l *UsageLedger) Get(key string) *UsageRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.recs.get(key)
}

func lowerBound(arr []*UsageRecord, ts float64) int {
	lo, hi := 0, len(arr)
	for lo < hi {
		mid := (lo + hi) >> 1
		if arr[mid].Ts < ts {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo
}

func (l *UsageLedger) Range(from, to float64) []*UsageRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	arr := l.snapshot()
	out := []*UsageRecord{}
	for i := lowerBound(arr, from); i < len(arr) && arr[i].Ts < to; i++ {
		out = append(out, arr[i])
	}
	return out
}

func (l *UsageLedger) LastTs(source string) (float64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	arr := l.snapshot()
	for i := len(arr) - 1; i >= 0; i-- {
		if arr[i].Source == source {
			return arr[i].Ts, true
		}
	}
	return 0, false
}

func (l *UsageLedger) All() []*UsageRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]*UsageRecord(nil), l.snapshot()...)
}

func sortByTs(out []*UsageRecord) {
	sort.SliceStable(out, func(i, j int) bool { return out[i].Ts-out[j].Ts < 0 })
}

func (l *UsageLedger) snapshot() []*UsageRecord {
	if l.sorted == nil {
		out := make([]*UsageRecord, 0, l.recs.size())
		l.recs.each(func(_ string, r *UsageRecord) bool { out = append(out, r); return true })
		sortByTs(out)
		l.sorted = out
	}
	return l.sorted
}

func (l *UsageLedger) placeInSorted(prev, next *UsageRecord) {
	arr := l.sorted
	if arr == nil {
		return
	}
	if prev == nil {
		if len(arr) == 0 || arr[len(arr)-1].Ts <= next.Ts {
			l.sorted = append(arr, next)
		} else {
			l.sorted = nil
		}
		return
	}
	if prev.Ts == next.Ts {
		for i := lowerBound(arr, prev.Ts); i < len(arr) && arr[i].Ts == prev.Ts; i++ {
			if arr[i] == prev {
				arr[i] = next
				return
			}
		}
	}
	l.sorted = nil
}

func (l *UsageLedger) routeSnapshot() []*UsageRecord {
	if l.routeSorted == nil {
		out := []*UsageRecord{}
		l.recs.each(func(_ string, r *UsageRecord) bool {
			if r.Via == "route" {
				out = append(out, r)
			}
			return true
		})
		sortByTs(out)
		l.routeSorted = out
	}
	return l.routeSorted
}

func (l *UsageLedger) RouteCovering(source string, ts float64, hint *RouteHint) *UsageRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	arr := l.routeSnapshot()
	left := ts - routeSlackMs - 10*60_000
	var best *UsageRecord
	bestScore := 0.0
	for i := lowerBound(arr, left); i < len(arr) && arr[i].Ts <= ts+routeSlackMs; i++ {
		r := arr[i]
		if r.Via != "route" || r.Source != source {
			continue
		}
		if ts < r.Ts-routeSlackMs || ts > r.Ts+or0(r.Dur, 0)+routeSlackMs {
			continue
		}
		if hint == nil {
			return r
		}
		if r.Key == hint.Key || (nonEmpty(r.Rid) && sameRequestID(hint.Key, *r.Rid)) {
			return r
		}
		if nonEmpty(r.LogKey) {
			if *r.LogKey == hint.Key {
				return r
			}
			continue
		}
		if r.Rid != nil && strings.HasPrefix(*r.Rid, "msg_") && strings.HasPrefix(hint.Key, "claude:msg_") {
			continue
		}
		if nonEmpty(r.Session) && nonEmpty(hint.Session) && *r.Session != *hint.Session {
			continue
		}
		rp := r.Input + r.CacheRead + r.CacheWrite
		dp := math.Abs(rp - hint.Prompt)
		if dp > math.Max(promptTolAbs, rp*promptTolRel) {
			continue
		}
		if hint.Output > r.Output+math.Max(promptTolAbs, r.Output*promptTolRel) {
			continue
		}
		score := dp + math.Abs(r.Output-hint.Output) + math.Abs(ts-r.Ts)/1000
		if best == nil || score < bestScore {
			best, bestScore = r, score
		}
	}
	return best
}

func (l *UsageLedger) CoveredByRoute(source string, ts float64) bool {
	return l.RouteCovering(source, ts, nil) != nil
}

// ---------------------------------------------------------------- 游标

func (l *UsageLedger) Cursor(p string) *FileCursor {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cursors.m[p]
}

func (l *UsageLedger) SetCursor(p string, c *FileCursor) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cursors.set(p, c)
	l.cursorDirty = true
	l.cursorGen++
	l.droppedDuringLoad.del(p)
	l.scheduleFlush()
}

func (l *UsageLedger) DropCursor(p string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.loaded {
		l.droppedDuringLoad.add(p)
	}
	if l.cursors.m[p] != nil {
		l.cursors.del(p)
		l.cursorDirty = true
		l.cursorGen++
	}
}

func (l *UsageLedger) CursorPaths() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.cursors.order...)
}

// ---------------------------------------------------------------- 保留与清空

func (l *UsageLedger) Prune(retention string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.pruneLocked(retention)
}

func (l *UsageLedger) pruneLocked(retention string) int {
	if !l.loaded {
		l.pendingPrune = retention
		return 0
	}
	keep, ok := RetentionMs[retention]
	if !ok || math.IsInf(keep, 0) || math.IsNaN(keep) {
		return 0
	}
	cutoff := l.now() - keep
	n := 0
	var del []string
	l.recs.each(func(k string, r *UsageRecord) bool {
		if r.Ts < cutoff {
			del = append(del, k)
		}
		return true
	})
	for _, k := range del {
		l.recs.del(k)
		n++
	}
	if n > 0 {
		l.sorted = nil
		l.routeSorted = nil
		l.ver++
		l.compactLocked()
	}
	return n
}

func (l *UsageLedger) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.recs.clear()
	l.sorted = nil
	l.routeSorted = nil
	l.ver++
	l.epoch++
	l.dirty = newOrderedSet()
	l.appendTainted = false
	l.lines = 0
	if err := WritePrivateFile(l.file, ""); err != nil {
		l.warn("usage clear failed", err.Error())
	}
}

// Compact：返回在这次（或排队那次）压缩结束后关闭的 channel
func (l *UsageLedger) Compact() <-chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.compactLocked()
}

func (l *UsageLedger) compactLocked() <-chan struct{} {
	if l.compactQueued != nil {
		return l.compactQueued.done
	}
	var before <-chan struct{}
	if l.compactRunning != nil {
		before = l.compactRunning.done
	} else if !l.loaded {
		before = l.ready
	}
	job := &compactJob{done: make(chan struct{})}
	start := func() {
		l.mu.Lock()
		if l.compactQueued == job {
			l.compactQueued = nil
		}
		l.compactRunning = job
		l.mu.Unlock()
		l.runCompact()
		l.mu.Lock()
		if l.compactRunning == job {
			l.compactRunning = nil
		}
		l.mu.Unlock()
		close(job.done)
	}
	if before == nil {
		l.compactRunning = job
		go func() {
			l.runCompact()
			l.mu.Lock()
			if l.compactRunning == job {
				l.compactRunning = nil
			}
			l.mu.Unlock()
			close(job.done)
		}()
		return job.done
	}
	l.compactQueued = job
	go func() { <-before; start() }()
	return job.done
}

func (l *UsageLedger) runCompact() {
	l.mu.Lock()
	if l.closed || l.noCompact {
		l.mu.Unlock()
		return
	}
	epoch := l.epoch
	snap := append([]*UsageRecord(nil), l.snapshot()...)
	ledgerTmpSeq++
	tmp := fmt.Sprintf("%s.%d.%d.tmp", l.file, os.Getpid(), ledgerTmpSeq)
	l.mu.Unlock()
	fail := func(err error) {
		_ = os.Remove(tmp)
		l.warn("usage compact failed", err.Error())
	}
	_ = os.Remove(tmp)
	fh, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		fail(err)
		return
	}
	aborted := false
	for i := 0; i < len(snap); i += compactBatch {
		l.mu.Lock()
		stop := l.closed || epoch != l.epoch
		l.mu.Unlock()
		if stop {
			aborted = true
			break
		}
		var b strings.Builder
		end := i + compactBatch
		if end > len(snap) {
			end = len(snap)
		}
		for j := i; j < end; j++ {
			b.WriteString(stringifyRec(snap[j]))
			b.WriteByte('\n')
		}
		if _, err := fh.WriteString(b.String()); err != nil {
			fh.Close()
			fail(err)
			return
		}
	}
	if err := fh.Close(); err != nil {
		fail(err)
		return
	}
	_ = aborted
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || epoch != l.epoch {
		_ = os.Remove(tmp)
		return
	}
	_ = os.Chmod(tmp, 0o600)
	if err := os.Rename(tmp, l.file); err != nil {
		_ = os.Remove(tmp)
		l.warn("usage compact failed", err.Error())
		return
	}
	inSnap := make(map[*UsageRecord]bool, len(snap))
	for _, r := range snap {
		inSnap[r] = true
	}
	next := newOrderedSet()
	l.recs.each(func(k string, r *UsageRecord) bool {
		if !inSnap[r] {
			next.add(k)
		}
		return true
	})
	l.dirty = next
	l.appendTainted = false
	l.lines = len(snap)
	if l.dirty.size() > 0 {
		if failed := l.appendDirty(); failed != nil {
			l.settle(failed)
		}
	}
	if l.dirty.size() > 0 || l.cursorDirty {
		l.scheduleFlush()
	}
}

func (l *UsageLedger) scheduleFlush() {
	if l.flushTimer != nil {
		return
	}
	ms := 1500.0
	if l.d.FlushMs != nil {
		ms = *l.d.FlushMs
	}
	l.flushGen++
	gen := l.flushGen
	l.flushTimer = time.AfterFunc(time.Duration(ms*float64(time.Millisecond)), func() {
		l.mu.Lock()
		if l.flushGen != gen || l.flushTimer == nil {
			l.mu.Unlock()
			return
		}
		l.flushTimer = nil
		l.flushSoon()
		l.mu.Unlock()
	})
}

func (l *UsageLedger) stopFlushTimer() {
	if l.flushTimer != nil {
		l.flushTimer.Stop()
		l.flushTimer = nil
		l.flushGen++
	}
}

type PersistState struct {
	Degraded       bool `json:"degraded"`
	PendingRecords int  `json:"pendingRecords"`
	CursorDirty    bool `json:"cursorDirty"`
}

func (l *UsageLedger) PersistState() PersistState {
	l.mu.Lock()
	defer l.mu.Unlock()
	return PersistState{l.degraded, l.dirty.size(), l.cursorDirty}
}

func (l *UsageLedger) appendDirty() error {
	if l.dirty.size() == 0 {
		return nil
	}
	keys := l.dirty.keys()
	var parts []string
	for _, k := range keys {
		if r := l.recs.get(k); r != nil {
			parts = append(parts, stringifyRec(r))
		}
	}
	body := strings.Join(parts, "\n")
	if body == "" {
		l.dirty = newOrderedSet()
		return nil
	}
	_, statErr := os.Stat(l.file)
	fresh := statErr != nil
	pre := ""
	if l.appendTainted {
		pre = "\n"
	}
	f, err := os.OpenFile(l.file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err == nil {
		_, err = f.WriteString(pre + body + "\n")
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		l.appendTainted = true
		return err
	}
	l.appendTainted = false
	for _, k := range keys {
		l.dirty.del(k)
	}
	if fresh {
		_ = os.Chmod(l.file, 0o600)
	}
	return nil
}

func (l *UsageLedger) cursorWritable() bool {
	return l.loaded && l.dirty.size() == 0 && l.cursorDirty
}

func (l *UsageLedger) settle(failed error) {
	was := l.degraded
	if failed != nil {
		if !l.degraded {
			l.warn("usage flush failed", failed.Error())
		}
		l.degraded = true
		l.scheduleFlush()
	} else {
		l.degraded = false
	}
	if was != l.degraded && l.d.OnPersistChange != nil {
		cb, v := l.d.OnPersistChange, l.degraded
		go cb(v)
	}
}

func (l *UsageLedger) flushSoon() {
	l.stopFlushTimer()
	if failed := l.appendDirty(); failed != nil {
		l.settle(failed)
		return
	}
	if l.cursorWritable() && l.compactRunning == nil && !l.cursorWriting {
		l.writeCursorsAsync()
		return
	}
	l.settle(nil)
}

func (l *UsageLedger) writeCursorsAsync() {
	gen := l.cursorGen
	l.cursorWriting = true
	data, _ := json.Marshal(l.cursors)
	go func() {
		l.cursorWriteMu.Lock()
		err := utils.WritePrivateFileAtomic(l.cursorFile, data)
		l.cursorWriteMu.Unlock()
		l.mu.Lock()
		defer l.mu.Unlock()
		l.cursorWriting = false
		if err == nil {
			if l.cursorSyncGen > gen {
				l.cursorDirty = true
			} else if l.cursorGen == gen {
				l.cursorDirty = false
			}
		}
		l.settle(err)
		if err == nil && l.cursorDirty {
			l.scheduleFlush()
		}
	}()
}

func (l *UsageLedger) Flush() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.flushLocked()
}

func (l *UsageLedger) flushLocked() {
	l.stopFlushTimer()
	failed := l.appendDirty()
	if failed == nil && l.cursorWritable() {
		data, _ := json.Marshal(l.cursors)
		if err := WritePrivateFile(l.cursorFile, string(data)); err != nil {
			failed = err
		} else {
			l.cursorSyncGen = l.cursorGen
			l.cursorDirty = false
		}
	}
	l.settle(failed)
}

func (l *UsageLedger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	l.flushLocked()
}
