package quality

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RetentionChoices = QUALITY_RETENTION_CHOICES
var RetentionChoices = []float64{7, 30, 90}

// DefaultRetentionDays = DEFAULT_RETENTION_DAYS
const DefaultRetentionDays = 30

const (
	cacheDays = 7
	dayMs     = 86_400_000
)

var fileRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.jsonl$`)

// Logger：warn / info
type Logger interface {
	Info(msg string, data any)
	Warn(msg string, data any)
}

// DayKey = dayKey（本地日期 YYYY-MM-DD）
func DayKey(ts float64) string {
	d := localOf(ts)
	return fmt.Sprintf("%d-%02d-%02d", d.Year(), int(d.Month()), d.Day())
}

func dayStart(key string) float64 {
	var y, m, d int
	fmt.Sscanf(key, "%d-%d-%d", &y, &m, &d)
	return localDate(y, time.Month(m), d, 0)
}

// LedgerDeps = QualityLedgerDeps
type LedgerDeps struct {
	Dir    string
	Logger Logger
	Now    func() float64
	// FlushMs：默认 500；<0 = 每条立即同步写（Node 的 0）
	FlushMs int
}

// Ledger = QualityLedger
type Ledger struct {
	d       LedgerDeps
	mu      sync.Mutex
	days    map[string][]*u.Obj
	pending map[string][]string
	order   []string // pending 的键序
	timer   *time.Timer
	wmu     sync.Mutex // 写盘串行
}

// NewLedger = new QualityLedger
func NewLedger(d LedgerDeps) *Ledger {
	return &Ledger{d: d, days: map[string][]*u.Obj{}, pending: map[string][]string{}}
}

func (l *Ledger) now() float64 {
	if l.d.Now != nil {
		return l.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (l *Ledger) file(key string) string { return filepath.Join(l.d.Dir, key+".jsonl") }

func (l *Ledger) warn(msg string, err error) {
	if l.d.Logger != nil {
		l.d.Logger.Warn(msg, map[string]any{"error": err.Error()})
	}
}

// Append = append
func (l *Ledger) Append(rec *u.Obj) {
	ts, _ := numOf(rec.Get("ts"))
	key := DayKey(ts)
	l.mu.Lock()
	if cached, ok := l.days[key]; ok {
		l.days[key] = append(cached, rec)
	} else if l.isRecent(key) {
		l.days[key] = append(l.readDay(key), rec)
	}
	if _, ok := l.pending[key]; !ok {
		l.order = append(l.order, key)
	}
	l.pending[key] = append(l.pending[key], u.Stringify(rec))
	l.mu.Unlock()
	l.schedule()
}

func (l *Ledger) isRecent(key string) bool {
	return dayStart(key) >= dayStart(DayKey(l.now()))-float64((cacheDays-1)*dayMs)
}

func (l *Ledger) schedule() {
	ms := l.d.FlushMs
	if ms == 0 {
		ms = 500
	}
	if ms < 0 {
		l.FlushSync()
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.timer != nil {
		return
	}
	l.timer = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		l.mu.Lock()
		l.timer = nil
		l.mu.Unlock()
		l.Flush()
	})
}

type chunk struct{ key, data string }

// take：调用方持有 l.mu
func (l *Ledger) take() []chunk {
	out := make([]chunk, 0, len(l.order))
	for _, k := range l.order {
		out = append(out, chunk{k, strings.Join(l.pending[k], "\n") + "\n"})
	}
	l.pending = map[string][]string{}
	l.order = nil
	return out
}

func (l *Ledger) stopTimer() {
	if l.timer != nil {
		l.timer.Stop()
		l.timer = nil
	}
}

func (l *Ledger) write(batch []chunk) error {
	if err := os.MkdirAll(l.d.Dir, 0o700); err != nil {
		return err
	}
	for _, c := range batch {
		f, err := os.OpenFile(l.file(c.key), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, err = f.WriteString(c.data)
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// Flush = flush（Node 异步；这里同步串行写完，失败只 warn）
func (l *Ledger) Flush() {
	l.mu.Lock()
	l.stopTimer()
	batch := l.take()
	l.wmu.Lock()
	l.mu.Unlock()
	defer l.wmu.Unlock()
	if len(batch) == 0 {
		return
	}
	if err := l.write(batch); err != nil {
		l.warn("quality ledger write failed", err)
	}
}

// FlushSync = flushSync：是否全部写成功
func (l *Ledger) FlushSync() bool {
	l.mu.Lock()
	l.stopTimer()
	batch := l.take()
	l.wmu.Lock()
	l.mu.Unlock()
	defer l.wmu.Unlock()
	if len(batch) == 0 {
		return true
	}
	if err := l.write(batch); err != nil {
		l.warn("quality ledger write failed", err)
		return false
	}
	return true
}

// readDay：调用方持有 l.mu
func (l *Ledger) readDay(key string) []*u.Obj {
	out := []*u.Obj{}
	b, _ := os.ReadFile(l.file(key))
	lines := strings.Split(string(b), "\n")
	lines = append(lines, l.pending[key]...)
	for _, line := range lines {
		if line == "" {
			continue
		}
		v, err := u.ParseString(line)
		if err != nil {
			continue
		}
		if r := SanitizeRecord(v); r != nil {
			out = append(out, r)
		}
	}
	return out
}

// Range = range([from, to))
func (l *Ledger) Range(from, to float64) []*u.Obj {
	out := []*u.Obj{}
	if !(to > from) {
		return out
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for t := dayStart(DayKey(from)); t < to; t = dayStart(DayKey(t + dayMs + 3_600_000)) {
		key := DayKey(t)
		list, ok := l.days[key]
		if !ok {
			list = l.readDay(key)
			if l.isRecent(key) {
				l.days[key] = list
			}
		}
		for _, r := range list {
			ts, _ := numOf(r.Get("ts"))
			if ts >= from && ts < to {
				out = append(out, r)
			}
		}
	}
	for k := range l.days {
		if !l.isRecent(k) {
			delete(l.days, k)
		}
	}
	return out
}

// DayKeys = dayKeys（升序）
func (l *Ledger) DayKeys() []string {
	ents, err := os.ReadDir(l.d.Dir)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, e := range ents {
		if m := fileRe.FindStringSubmatch(e.Name()); m != nil {
			out = append(out, m[1])
		}
	}
	sort.Strings(out)
	return out
}

// Prune = prune：返回删除的天数
func (l *Ledger) Prune(retentionDays float64) int {
	if retentionDays < 1 {
		retentionDays = 1
	}
	keep := dayStart(DayKey(l.now())) - float64((retentionDays-1)*dayMs)
	removed := 0
	for _, key := range l.DayKeys() {
		if dayStart(key) >= keep {
			continue
		}
		if err := os.Remove(l.file(key)); err != nil && !os.IsNotExist(err) {
			l.warn("quality ledger prune failed", err)
			continue
		}
		l.mu.Lock()
		delete(l.days, key)
		l.mu.Unlock()
		removed++
	}
	return removed
}

// Clear = clear：内存、待写与全部文件
func (l *Ledger) Clear() error {
	l.mu.Lock()
	l.stopTimer()
	l.pending = map[string][]string{}
	l.order = nil
	l.mu.Unlock()
	l.wmu.Lock() // await this.writing
	l.wmu.Unlock()
	l.mu.Lock()
	l.days = map[string][]*u.Obj{}
	l.mu.Unlock()
	for _, key := range l.DayKeys() {
		if err := os.Remove(l.file(key)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// Dispose = dispose
func (l *Ledger) Dispose() { l.FlushSync() }
