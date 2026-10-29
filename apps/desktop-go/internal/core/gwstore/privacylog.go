package gwstore

// privacylog.go = PrivacyLog.ts：最近隐藏的密钥（只有元数据），按占位符合并，攒 2 秒写盘。

import (
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	privacyLogCap   = 200
	privacyFlushDur = 2000 * time.Millisecond
)

func plStr(v any, max int) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return u.UTF16Slice0(s, max)
}

func plNum(v any) float64 {
	f, ok := v.(float64)
	if ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0 {
		return f
	}
	return 0
}

// PrivacyLog = PrivacyLog
type PrivacyLog struct {
	file    string
	now     func() float64
	mu      sync.Mutex
	order   []string
	entries map[string]*u.Obj
	timer   *time.Timer
	loaded  bool
	wmu     sync.Mutex // 写队列（writePrivateFileAtomicAsync 串行）
}

func NewPrivacyLog(file string, now func() float64) *PrivacyLog {
	if now == nil {
		now = func() float64 { return Now() }
	}
	return &PrivacyLog{file: file, now: now, entries: map[string]*u.Obj{}}
}

func (l *PrivacyLog) remove(p string) {
	if _, ok := l.entries[p]; !ok {
		return
	}
	delete(l.entries, p)
	for i, k := range l.order {
		if k == p {
			l.order = append(l.order[:i:i], l.order[i+1:]...)
			break
		}
	}
}

func (l *PrivacyLog) put(p string, e *u.Obj) {
	l.remove(p)
	l.entries[p] = e
	l.order = append(l.order, p)
}

// mapSet = Map.set：已有的键保持原位置
func (l *PrivacyLog) mapSet(p string, e *u.Obj) {
	if _, ok := l.entries[p]; !ok {
		l.order = append(l.order, p)
	}
	l.entries[p] = e
}

// Note = note(e)：有 redactions 才记
func (l *PrivacyLog) Note(e *u.Obj) {
	if e == nil {
		return
	}
	hits, _ := e.Get("redactions").([]any)
	if len(hits) == 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	at := l.now()
	for _, hr := range hits {
		h := asObj(hr)
		if h == nil {
			h = u.NewObj()
		}
		p := plStr(h.Get("placeholder"), 64)
		if p == "" {
			continue
		}
		client := plStr(e.Get("client"), 32)
		entry, had := l.entries[p]
		if !had {
			entry = u.NewObj("placeholder", p, "kind", plStr(h.Get("kind"), 32), "len", plNum(h.Get("len")),
				"head", plStr(h.Get("head"), 4), "allowTag", plStr(h.Get("allowTag"), 16), "action", plStr(h.Get("action"), 8),
				"firstAt", at, "lastAt", at, "requests", 0.0, "masked", 0.0, "restored", 0.0, "clients", []any{})
		}
		entry.Set("lastAt", at)
		if a := plStr(h.Get("action"), 8); a != "" {
			entry.Set("action", a)
		}
		entry.Set("requests", entry.Get("requests").(float64)+1)
		entry.Set("masked", entry.Get("masked").(float64)+plNum(h.Get("masked")))
		entry.Set("restored", entry.Get("restored").(float64)+plNum(h.Get("restored")))
		cl, _ := entry.Get("clients").([]any)
		if client != "" {
			found := false
			for _, c := range cl {
				if c == client {
					found = true
				}
			}
			if !found {
				entry.Set("clients", append(append([]any{}, cl...), client))
			}
		}
		l.put(p, entry)
	}
	for len(l.order) > privacyLogCap {
		l.remove(l.order[0])
	}
	l.schedule()
}

// List = list()：最近出现的在前
func (l *PrivacyLog) List() []any {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	out := make([]any, 0, len(l.order))
	for i := len(l.order) - 1; i >= 0; i-- {
		out = append(out, l.entries[l.order[i]].Clone())
	}
	return out
}

// Clear = clear()（等写完）
func (l *PrivacyLog) Clear() {
	l.mu.Lock()
	l.loaded = true
	l.entries = map[string]*u.Obj{}
	l.order = nil
	data := l.snapshotLocked()
	l.mu.Unlock()
	l.write(data)
}

// Flush = flush()（退出时，同步写完）
func (l *PrivacyLog) Flush() {
	l.mu.Lock()
	data := l.snapshotLocked()
	l.mu.Unlock()
	l.write(data)
}

func (l *PrivacyLog) snapshotLocked() []byte {
	if l.timer != nil {
		l.timer.Stop()
	}
	l.timer = nil
	arr := make([]any, 0, len(l.order))
	for _, k := range l.order {
		arr = append(arr, l.entries[k])
	}
	return []byte(u.Stringify(arr))
}

func (l *PrivacyLog) write(data []byte) {
	l.wmu.Lock()
	defer l.wmu.Unlock()
	_ = os.MkdirAll(filepath.Dir(l.file), 0o755)
	_ = utils.WritePrivateFileAtomic(l.file, data)
}

func (l *PrivacyLog) schedule() {
	if l.timer != nil {
		return
	}
	l.timer = time.AfterFunc(privacyFlushDur, func() {
		l.mu.Lock()
		l.timer = nil
		data := l.snapshotLocked()
		l.mu.Unlock()
		l.write(data)
	})
}

func (l *PrivacyLog) load() {
	if l.loaded {
		return
	}
	l.loaded = true
	b, err := os.ReadFile(l.file)
	if err != nil {
		return
	}
	raw, err := u.Parse(b)
	if err != nil {
		return
	}
	arr, ok := raw.([]any)
	if !ok {
		return
	}
	if len(arr) > privacyLogCap {
		arr = arr[len(arr)-privacyLogCap:]
	}
	for _, r := range arr {
		o := asObj(r)
		if o == nil {
			continue
		}
		p := plStr(o.Get("placeholder"), 64)
		if p == "" {
			continue
		}
		clients := []any{}
		if ca, ok := o.Get("clients").([]any); ok {
			for _, c := range ca {
				if s, ok := c.(string); ok {
					clients = append(clients, s)
				}
			}
			if len(clients) > 16 {
				clients = clients[:16]
			}
		}
		l.mapSet(p, u.NewObj("placeholder", p, "kind", plStr(o.Get("kind"), 32), "len", plNum(o.Get("len")),
			"head", plStr(o.Get("head"), 4), "allowTag", plStr(o.Get("allowTag"), 16), "action", plStr(o.Get("action"), 8),
			"firstAt", plNum(o.Get("firstAt")), "lastAt", plNum(o.Get("lastAt")), "requests", plNum(o.Get("requests")),
			"masked", plNum(o.Get("masked")), "restored", plNum(o.Get("restored")), "clients", clients))
	}
}
