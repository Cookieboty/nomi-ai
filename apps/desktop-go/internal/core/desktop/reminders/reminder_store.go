// Package reminders 移植 packages/core/src/desktop/reminders/ReminderStore.ts：
// 持久化在 <root>/reminders.json，应用运行时到点触发，关闭期间到期的标记为 missed。
package reminders

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/jsjson"
	"sync"
	"time"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// Reminder 一条提醒（新建的按 Node 字段顺序；从磁盘读来的保留原键序与未知字段）
type Reminder struct {
	ID        string   `json:"id"`
	Text      string   `json:"text"`
	DueAt     float64  `json:"dueAt"`
	CreatedAt float64  `json:"createdAt"`
	Status    string   `json:"status"`
	FiredAt   *float64 `json:"firedAt,omitempty"`
	Snoozes   *int     `json:"snoozes,omitempty"`
	Announced *bool    `json:"announced,omitempty"`
	Repeat    *Repeat  `json:"repeat,omitempty"`
	AnchorAt  *float64 `json:"anchorAt,omitempty"`
	FireCount *int     `json:"fireCount,omitempty"`
	// raw/loaded：磁盘上的原对象和加载时的已知字段，写回时保留未知字段与键序（同 Node {...r}）
	raw    *deps.OrderedObject
	loaded []byte
}

type reminderJSON Reminder

func (r Reminder) MarshalJSON() ([]byte, error) {
	cur, err := json.Marshal(reminderJSON(r))
	if err != nil || r.raw == nil {
		return cur, err
	}
	return deps.OverlayKnown(r.raw, r.loaded, cur)
}

func (r Reminder) clone() Reminder {
	c := r
	if r.Repeat != nil {
		rp := *r.Repeat
		c.Repeat = &rp
	}
	return c
}

var ReminderID = regexp.MustCompile(`^r[0-9a-z]{6,24}$`)

const (
	missedGraceMs = 60_000
	maxWait       = 1<<31 - 1
	keepDone      = 200
)

// Error 带 code 的错误
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Message }

// Timers 可注入的定时器
type Timers interface {
	SetTimeout(fn func(), ms float64) any
	ClearTimeout(h any)
}

type realTimers struct{}

func (realTimers) SetTimeout(fn func(), ms float64) any {
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, fn)
}
func (realTimers) ClearTimeout(h any) { h.(*time.Timer).Stop() }

type Store struct {
	file   string
	now    func() float64
	timers Timers

	mu        sync.Mutex
	items     []*Reminder
	timer     any
	listeners []func()
	OnFire    func(r Reminder)
}

func NowMs() float64 { return float64(time.Now().UnixMilli()) }

func New(file string, now func() float64, timers Timers) *Store {
	if now == nil {
		now = NowMs
	}
	if timers == nil {
		timers = realTimers{}
	}
	s := &Store{file: file, now: now, timers: timers}
	s.items = s.read()
	return s
}

func (s *Store) read() []*Reminder {
	out := []*Reminder{}
	b, err := os.ReadFile(s.file)
	if err != nil {
		return out
	}
	var raw struct {
		Reminders []json.RawMessage `json:"reminders"`
	}
	if json.Unmarshal(b, &raw) != nil || raw.Reminders == nil {
		return out
	}
	for _, x := range raw.Reminders {
		var probe map[string]json.RawMessage
		if json.Unmarshal(x, &probe) != nil || probe == nil {
			continue
		}
		var id, text string
		var due float64
		if json.Unmarshal(probe["id"], &id) != nil || !ReminderID.MatchString(id) || json.Unmarshal(probe["text"], &text) != nil || json.Unmarshal(probe["dueAt"], &due) != nil {
			continue
		}
		rp := probe["repeat"]
		delete(probe, "repeat")
		clean, _ := json.Marshal(probe)
		var r Reminder
		_ = json.Unmarshal(clean, &r)
		r.Repeat = SanitizeRepeat(rp)
		if v, err := deps.ParseJSONOrdered(x); err == nil {
			if o, ok := v.(*deps.OrderedObject); ok {
				// {...r, repeat: sanitizeRepeat(r.repeat)}
				if r.Repeat != nil {
					o.Set("repeat", r.Repeat)
				} else {
					o.Delete("repeat")
				}
				r.raw = o
				r.loaded, _ = json.Marshal(reminderJSON(r))
			}
		}
		out = append(out, &r)
	}
	return out
}

func (s *Store) saveLocked() {
	active, ended := []*Reminder{}, []*Reminder{}
	for _, r := range s.items {
		if r.Status == "pending" {
			active = append(active, r)
		} else {
			ended = append(ended, r)
		}
	}
	slices.SortStableFunc(ended, func(a, b *Reminder) int { return cmpF(b.DueAt, a.DueAt) })
	if len(ended) > keepDone {
		ended = ended[:keepDone]
	}
	s.items = append(active, ended...)
	_ = os.MkdirAll(filepath.Dir(s.file), 0o777)
	tmp := fmt.Sprintf("%s.%d.tmp", s.file, os.Getpid())
	list := make([]Reminder, len(s.items))
	for i, r := range s.items {
		list[i] = *r
	}
	_ = os.WriteFile(tmp, []byte(pretty(map[string]any{"version": 1, "reminders": list})), 0o600)
	_ = os.Rename(tmp, s.file)
}

func pretty(v map[string]any) string {
	// {"version":1,"reminders":[...]} 键序固定
	type file struct {
		Version   int        `json:"version"`
		Reminders []Reminder `json:"reminders"`
	}
	return jsjson.Pretty(file{1, v["reminders"].([]Reminder)})
}

func cmpF(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func (s *Store) changed() {
	s.mu.Lock()
	ls := slices.Clone(s.listeners)
	s.mu.Unlock()
	for _, l := range ls {
		l()
	}
}

func (s *Store) OnChange(fn func()) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

// Start：把关闭期间错过的标记为 missed，返回尚未播报的；然后开始调度
func (s *Store) Start() []Reminder {
	s.mu.Lock()
	t := s.now()
	changed := false
	missedRepeats := []Reminder{}
	for _, r := range s.items {
		if r.Status == "pending" && r.DueAt < t-missedGraceMs {
			changed = true
			if r.Repeat != nil {
				c := r.clone()
				c.Status = "missed"
				missedRepeats = append(missedRepeats, c)
				anchor := r.DueAt
				if r.AnchorAt != nil {
					anchor = *r.AnchorAt
				}
				r.DueAt = NextOccurrence(*r.Repeat, anchor, t)
			} else {
				r.Status = "missed"
			}
		}
	}
	if changed {
		s.saveLocked()
	}
	s.scheduleLocked()
	out := []Reminder{}
	for _, r := range s.items {
		if r.Status == "missed" && (r.Announced == nil || !*r.Announced) {
			out = append(out, r.clone())
		}
	}
	s.mu.Unlock()
	if changed {
		s.changed()
	}
	return append(out, missedRepeats...)
}

func (s *Store) MarkAnnounced(ids []string) {
	s.mu.Lock()
	changed := false
	for _, r := range s.items {
		if slices.Contains(ids, r.ID) && (r.Announced == nil || !*r.Announced) {
			t := true
			r.Announced = &t
			changed = true
		}
	}
	if changed {
		s.saveLocked()
	}
	s.mu.Unlock()
	if changed {
		s.changed()
	}
}

func (s *Store) Stop() {
	s.mu.Lock()
	s.stopLocked()
	s.mu.Unlock()
}

func (s *Store) stopLocked() {
	if s.timer != nil {
		s.timers.ClearTimeout(s.timer)
	}
	s.timer = nil
}

func (s *Store) scheduleLocked() {
	s.stopLocked()
	var next *Reminder
	for _, r := range s.items {
		if r.Status == "pending" && (next == nil || r.DueAt < next.DueAt) {
			next = r
		}
	}
	if next == nil {
		return
	}
	wait := math.Max(0, math.Min(maxWait, next.DueAt-s.now()))
	s.timer = s.timers.SetTimeout(s.Tick, wait)
}

// Tick 触发所有到期的提醒
func (s *Store) Tick() {
	s.mu.Lock()
	s.timer = nil
	t := s.now()
	fired := []Reminder{}
	n := 0
	for _, r := range s.items {
		if r.Status != "pending" || r.DueAt > t {
			continue
		}
		n++
		ft := t
		r.FiredAt = &ft
		if r.Repeat != nil {
			c := r.clone()
			c.Status = "fired"
			fired = append(fired, c)
			fc := 1
			if r.FireCount != nil {
				fc = *r.FireCount + 1
			}
			r.FireCount = &fc
			anchor := r.DueAt
			if r.AnchorAt != nil {
				anchor = *r.AnchorAt
			}
			r.DueAt = NextOccurrence(*r.Repeat, anchor, t)
		} else {
			r.Status = "fired"
			fired = append(fired, r.clone())
		}
	}
	if n > 0 {
		s.saveLocked()
	}
	onFire := s.OnFire
	s.mu.Unlock()
	if n > 0 {
		s.changed()
	}
	for _, r := range fired {
		if onFire != nil {
			func() {
				defer func() { _ = recover() }()
				onFire(r)
			}()
		}
	}
	s.mu.Lock()
	s.scheduleLocked()
	s.mu.Unlock()
}

func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func toBase36(n int64) string { return strconv.FormatInt(n, 36) }

// Create 新建提醒（text 已裁剪由调用方负责；这里再 trim + 500）
func (s *Store) Create(text string, dueAt float64, repeat *Repeat) Reminder {
	s.mu.Lock()
	t := s.now()
	var rb [3]byte
	_, _ = rand.Read(rb[:])
	r := &Reminder{ID: "r" + toBase36(int64(t)) + hex.EncodeToString(rb[:]), Text: clip(trimJS2(text), 500), DueAt: jsRound(dueAt), CreatedAt: t, Status: "pending"}
	if repeat != nil {
		r.Repeat = repeat
		a := jsRound(dueAt)
		r.AnchorAt = &a
	}
	s.items = append(s.items, r)
	s.saveLocked()
	s.scheduleLocked()
	out := r.clone()
	s.mu.Unlock()
	s.changed()
	return out
}

func (s *Store) getLocked(id string) *Reminder {
	for _, r := range s.items {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func (s *Store) Get(id string) *Reminder {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.getLocked(id); r != nil {
		c := r.clone()
		return &c
	}
	return nil
}

// List：includeEnded / limit（默认 100）
func (s *Store) List(includeEnded bool, limit int) []Reminder {
	if limit == 0 {
		limit = 100
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sel := []*Reminder{}
	for _, r := range s.items {
		if includeEnded || r.Status == "pending" {
			sel = append(sel, r)
		}
	}
	slices.SortStableFunc(sel, func(a, b *Reminder) int {
		if a.Status == "pending" && b.Status == "pending" {
			return cmpF(a.DueAt, b.DueAt)
		}
		return cmpF(b.DueAt, a.DueAt)
	})
	if len(sel) > limit {
		sel = sel[:limit]
	}
	out := make([]Reminder, len(sel))
	for i, r := range sel {
		out[i] = r.clone()
	}
	return out
}

// Change mutate 的结果
type Change struct {
	Before Reminder `json:"before"`
	After  Reminder `json:"after"`
}

func (s *Store) mutate(id string, fn func(r *Reminder) error) (Change, error) {
	s.mu.Lock()
	r := s.getLocked(id)
	if r == nil {
		s.mu.Unlock()
		return Change{}, &Error{"not_found", tr.T("electron.common.reminder-not-found")}
	}
	before := r.clone()
	if err := fn(r); err != nil {
		s.mu.Unlock()
		return Change{}, err
	}
	s.saveLocked()
	s.scheduleLocked()
	after := r.clone()
	s.mu.Unlock()
	s.changed()
	return Change{before, after}, nil
}

func (s *Store) Cancel(id string) (Change, error) {
	return s.mutate(id, func(r *Reminder) error {
		if r.Status != "pending" {
			return &Error{"invalid_state", tr.T("electron.common.only-reminders-that-haven-t-fired-can-be")}
		}
		r.Status = "cancelled"
		return nil
	})
}

func (s *Store) Snooze(id string, minutes float64) (Change, error) {
	return s.mutate(id, func(r *Reminder) error {
		if r.Status == "cancelled" {
			return &Error{"invalid_state", tr.T("electron.common.reminder-cancelled")}
		}
		r.Status = "pending"
		r.DueAt = s.now() + jsRound(minutes*60_000)
		n := 1
		if r.Snoozes != nil {
			n = *r.Snoozes + 1
		}
		r.Snoozes = &n
		r.FiredAt = nil
		return nil
	})
}

func (s *Store) Dismiss(id string) (Change, error) {
	return s.mutate(id, func(r *Reminder) error {
		if r.Status == "fired" || r.Status == "missed" {
			r.Status = "done"
		}
		return nil
	})
}

// Patch update 的参数；RepeatNull 表示 repeat: null
type Patch struct {
	Text       *string
	DueAt      *float64
	Repeat     *Repeat
	RepeatNull bool
}

func (s *Store) Update(id string, p Patch) (Change, error) {
	return s.mutate(id, func(r *Reminder) error {
		if r.Status != "pending" {
			return &Error{"invalid_state", tr.T("electron.common.only-unfired-reminders-can-be-changed")}
		}
		if p.Text != nil && trimJS2(*p.Text) != "" {
			r.Text = clip(trimJS2(*p.Text), 500)
		}
		if p.DueAt != nil && !math.IsInf(*p.DueAt, 0) && !math.IsNaN(*p.DueAt) {
			r.DueAt = jsRound(*p.DueAt)
		}
		if p.RepeatNull {
			r.Repeat, r.AnchorAt = nil, nil
		} else if p.Repeat != nil {
			r.Repeat = p.Repeat
			a := r.DueAt
			r.AnchorAt = &a
		} else if r.Repeat != nil && p.DueAt != nil {
			a := r.DueAt
			r.AnchorAt = &a
		}
		return nil
	})
}

// Today 今天（本地时区）内还要触发的
func (s *Store) Today() []Reminder {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := local(s.now())
	end := msOf(time.Date(d.Year(), d.Month(), d.Day()+1, 0, 0, 0, 0, time.Local))
	sel := []*Reminder{}
	for _, r := range s.items {
		if r.Status == "pending" && r.DueAt < end {
			sel = append(sel, r)
		}
	}
	slices.SortStableFunc(sel, func(a, b *Reminder) int { return cmpF(a.DueAt, b.DueAt) })
	out := make([]Reminder, len(sel))
	for i, r := range sel {
		out[i] = r.clone()
	}
	return out
}

// Restore 原样写回（撤销用）
func (s *Store) Restore(snap Reminder) {
	s.mu.Lock()
	c := snap.clone()
	if r := s.getLocked(snap.ID); r != nil {
		*r = c
	} else {
		s.items = append(s.items, &c)
	}
	s.saveLocked()
	s.scheduleLocked()
	s.mu.Unlock()
	s.changed()
}

// DueInput resolveDue 的参数
type DueInput struct {
	At        string
	InMinutes *float64
	InSeconds *float64
}

// ResolveDue：返回毫秒时间戳，无效时 ok=false
func ResolveDue(i DueInput, now float64) (float64, bool) {
	if i.InSeconds != nil {
		return now + *i.InSeconds*1000, true
	}
	if i.InMinutes != nil {
		return now + *i.InMinutes*60_000, true
	}
	if i.At != "" {
		return DateParse(i.At)
	}
	return 0, false
}
