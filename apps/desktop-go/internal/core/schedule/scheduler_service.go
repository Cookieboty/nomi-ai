package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

type Freq struct {
	PerDay int    `json:"perDay"`
	GapMin int    `json:"gapMin"`
	Label  string `json:"label"`
}

var FREQ = map[string]Freq{
	"low":    {1, 360, "electron.common.occasionally-at-most-once-a-day"},
	"medium": {3, 180, "electron.common.moderate-at-most-3-times-a-day"},
	"high":   {6, 90, "electron.common.often-at-most-6-times-a-day"},
}

type Proactive struct {
	Enabled          bool   `json:"enabled"`
	Frequency        string `json:"frequency"`
	ActiveStart      string `json:"activeStart"`
	ActiveEnd        string `json:"activeEnd"`
	SkipIfChattedMin int    `json:"skipIfChattedMin"`
}

type SchedSettings struct {
	Quiet     QuietHours `json:"quiet"`
	Proactive Proactive  `json:"proactive"`
}

var DefaultSched = SchedSettings{
	Quiet:     QuietHours{Enabled: false, Start: "22:30", End: "08:00"},
	Proactive: Proactive{Enabled: false, Frequency: "low", ActiveStart: "09:00", ActiveEnd: "21:00", SkipIfChattedMin: 30},
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// SanitizeSched：raw 是 JSON 解出的任意值；base 缺省 DefaultSched
func SanitizeSched(raw any, base SchedSettings) SchedSettings {
	o := asMap(raw)
	q := asMap(o["quiet"])
	p := asMap(o["proactive"])
	b := func(v any, d bool) bool {
		if x, ok := v.(bool); ok {
			return x
		}
		return d
	}
	t := func(v any, d string) string {
		if ValidHHMM(v) {
			return v.(string)
		}
		return d
	}
	freq := base.Proactive.Frequency
	if f, ok := p["frequency"].(string); ok && f != "" {
		if _, ok := FREQ[f]; ok {
			freq = f
		}
	}
	skip := base.Proactive.SkipIfChattedMin
	if n, ok := p["skipIfChattedMin"].(float64); ok && n >= 0 {
		skip = int(min(600, jsRound(n)))
	}
	return SchedSettings{
		Quiet: QuietHours{
			Enabled: b(q["enabled"], base.Quiet.Enabled),
			Start:   t(q["start"], base.Quiet.Start),
			End:     t(q["end"], base.Quiet.End),
		},
		Proactive: Proactive{
			Enabled:          b(p["enabled"], base.Proactive.Enabled),
			Frequency:        freq,
			ActiveStart:      t(p["activeStart"], base.Proactive.ActiveStart),
			ActiveEnd:        t(p["activeEnd"], base.Proactive.ActiveEnd),
			SkipIfChattedMin: skip,
		},
	}
}

type SchedTask struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Prompt     string  `json:"prompt"`
	Time       string  `json:"time"`
	Repeat     Repeat  `json:"repeat"`
	Enabled    bool    `json:"enabled"`
	Template   string  `json:"template,omitempty"`
	CreatedAt  int64   `json:"createdAt"`
	NextRunAt  int64   `json:"nextRunAt"`
	LastRunAt  *int64  `json:"lastRunAt,omitempty"`
	LastStatus string  `json:"lastStatus,omitempty"`
	LastError  *string `json:"lastError,omitempty"`
}

type TaskResult struct {
	ID      string `json:"id"`
	TaskID  string `json:"taskId"`
	Name    string `json:"name"`
	At      int64  `json:"at"`
	OK      bool   `json:"ok"`
	Text    string `json:"text"`
	CatchUp *bool  `json:"catchUp,omitempty"`
}

type proactiveState struct {
	Day    string `json:"day"`
	Count  int    `json:"count"`
	LastAt int64  `json:"lastAt"`
}

type persist struct {
	V         int            `json:"v"`
	Settings  SchedSettings  `json:"settings"`
	Tasks     []*SchedTask   `json:"tasks"`
	Results   []TaskResult   `json:"results"`
	Proactive proactiveState `json:"proactive"`
}

const (
	CatchUpMs    = 12 * 3600_000
	TickMs       = 30_000
	MaxResults   = 50
	catchUpDelay = 8 * time.Second
)

// SchedError 对应 Node 的 SchedError(code)；契约层映射为 SCHED_<CODE>
type SchedError struct {
	Code string
	Msg  string
}

func (e *SchedError) Error() string { return e.Msg }

type Deps struct {
	Root     string
	Logger   deps.Logger
	Desktop  deps.Desktop
	Complete deps.CompleteFunc
	// Memory：长期记忆背景（persona + 事实），没有时返回空串
	Memory   func(ctx context.Context, q string) (string, error)
	OpenChat func()
	Now      func() int64
	Ports    deps.Ports
	Events   deps.Events
	T        i18n.Translate
	// Rand：Math.random()，测试可注入
	Rand  func() float64
	NewID func() string
	// AppName：brand.appName
	AppName string
}

type Service struct {
	d             Deps
	mu            sync.Mutex
	data          persist
	timer         *time.Ticker
	stopCh        chan struct{}
	running       []string
	lastChatAt    int64
	proactiveBusy bool
}

func DayKey(t int64) string {
	d := local(t)
	return fmt.Sprintf("%d-%d-%d", d.Year(), int(d.Month()), d.Day())
}

// hhmm：toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', hour12:false})
func hhmm(t int64) string {
	d := local(t)
	return fmt.Sprintf("%02d:%02d", d.Hour(), d.Minute())
}

func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.Identity
	}
	if d.Rand == nil {
		d.Rand = rand.Float64
	}
	if d.NewID == nil {
		d.NewID = deps.RandomUUID
	}
	if d.Logger == nil {
		d.Logger = deps.StdLogger{Prefix: "[sched]"}
	}
	if d.AppName == "" {
		d.AppName = "Nomi"
	}
	if d.Complete == nil {
		d.Complete = deps.UnavailableComplete
	}
	if d.Memory == nil {
		d.Memory = func(context.Context, string) (string, error) { return "", nil }
	}
	s := &Service{d: d}
	s.data = s.load()
	d.Desktop.SetNotifyPolicy(deps.NotifyPolicy{
		Quiet: s.IsQuiet,
		QuietEndsAt: func() int64 {
			s.mu.Lock()
			q := s.data.Settings.Quiet
			s.mu.Unlock()
			return QuietEndsAt(q, s.d.Now())
		},
	})
	return s
}

func (s *Service) file() string { return filepath.Join(s.d.Root, "schedule.json") }

func emptyPersist() persist {
	return persist{V: 1, Settings: SanitizeSched(map[string]any{}, DefaultSched), Tasks: []*SchedTask{}, Results: []TaskResult{}}
}

func (s *Service) load() persist {
	b, err := os.ReadFile(s.file())
	if err != nil {
		return emptyPersist()
	}
	var j map[string]json.RawMessage
	if json.Unmarshal(b, &j) != nil || j == nil {
		return emptyPersist()
	}
	var settings any
	_ = json.Unmarshal(j["settings"], &settings)
	out := persist{V: 1, Settings: SanitizeSched(settings, DefaultSched), Tasks: []*SchedTask{}, Results: []TaskResult{}}
	var tasks []json.RawMessage
	if json.Unmarshal(j["tasks"], &tasks) == nil {
		for _, raw := range tasks {
			var probe map[string]any
			if json.Unmarshal(raw, &probe) != nil || probe == nil {
				continue
			}
			if _, ok := probe["id"].(string); !ok || SanitizeRepeat(probe["repeat"]) == nil {
				continue
			}
			var t SchedTask
			if json.Unmarshal(raw, &t) == nil {
				out.Tasks = append(out.Tasks, &t)
			}
		}
	}
	var results []TaskResult
	if json.Unmarshal(j["results"], &results) == nil && results != nil {
		if len(results) > MaxResults {
			results = results[:MaxResults]
		}
		out.Results = results
	}
	if raw, ok := j["proactive"]; ok && string(raw) != "null" {
		_ = json.Unmarshal(raw, &out.Proactive)
	}
	return out
}

// saveLocked：tmp + rename、2 空格缩进、0600，然后广播 sched.changed
func (s *Service) saveLocked() {
	_ = os.MkdirAll(s.d.Root, 0o755)
	b, err := deps.Stringify(s.data, "  ")
	if err == nil {
		tmp := s.file() + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, s.file())
		}
	}
	s.broadcast("sched.changed", nil)
}

func (s *Service) IsQuiet() bool {
	s.mu.Lock()
	q := s.data.Settings.Quiet
	s.mu.Unlock()
	return InQuiet(q, s.d.Now())
}

func (s *Service) Settings() SchedSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Settings
}

func toAny(v any) map[string]any {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func (s *Service) SetSettings(patch any) SchedSettings {
	p := asMap(patch)
	wasQuiet := s.IsQuiet()
	s.mu.Lock()
	cur := s.data.Settings
	merged := toAny(cur)
	for k, v := range p {
		merged[k] = v
	}
	mq := toAny(cur.Quiet)
	for k, v := range asMap(p["quiet"]) {
		mq[k] = v
	}
	mp := toAny(cur.Proactive)
	for k, v := range asMap(p["proactive"]) {
		mp[k] = v
	}
	merged["quiet"], merged["proactive"] = mq, mp
	s.data.Settings = SanitizeSched(merged, cur)
	s.saveLocked()
	st := s.data.Settings
	s.mu.Unlock()
	if wasQuiet && !s.IsQuiet() {
		s.d.Desktop.FlushDeferred()
	}
	s.audit("schedule_settings", deps.O("quiet", st.Quiet.Enabled, "proactive", st.Proactive.Enabled), "ok", nil)
	return st
}

func (s *Service) tasksLocked() []SchedTask {
	out := make([]SchedTask, len(s.data.Tasks))
	for i, t := range s.data.Tasks {
		out[i] = *t
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].NextRunAt < out[j].NextRunAt })
	return out
}

func (s *Service) Tasks() []SchedTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tasksLocked()
}

func (s *Service) find(id string) *SchedTask {
	for _, t := range s.data.Tasks {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func (s *Service) UpsertTask(raw any) (SchedTask, error) {
	o := asMap(raw)
	rp := SanitizeRepeat(o["repeat"])
	if rp == nil {
		rp = &Repeat{Kind: "daily"}
	}
	repeat := *rp
	tm := "08:00"
	if ValidHHMM(o["time"]) {
		tm = o["time"].(string)
	}
	name := ""
	if n, ok := o["name"].(string); ok && deps.Trim(n) != "" {
		name = deps.TrimSlice(n, 40)
	}
	prompt := ""
	if p, ok := o["prompt"].(string); ok {
		prompt = deps.TrimSlice(p, 2000)
	}
	if name == "" {
		return SchedTask{}, &SchedError{"invalid", s.d.T("electron.common.please-enter-a-task-name")}
	}
	if prompt == "" {
		return SchedTask{}, &SchedError{"invalid", s.d.T("electron.common.please-enter-what-the-assistant-should-do")}
	}
	now := s.d.Now()
	s.mu.Lock()
	var t *SchedTask
	if id, ok := o["id"].(string); ok && id != "" {
		t = s.find(id)
	}
	if t != nil {
		timingChanged := t.Time != tm || deps.MustStringify(t.Repeat, "") != deps.MustStringify(repeat, "")
		t.Name, t.Prompt, t.Time, t.Repeat = name, prompt, tm, repeat
		if e, ok := o["enabled"].(bool); ok {
			t.Enabled = e
		}
		if timingChanged {
			t.NextRunAt = FirstRun(tm, repeat, now)
		}
	} else {
		enabled := true
		if e, ok := o["enabled"].(bool); ok {
			enabled = e
		}
		t = &SchedTask{ID: s.d.NewID(), Name: name, Prompt: prompt, Time: tm, Repeat: repeat, Enabled: enabled,
			CreatedAt: now, NextRunAt: FirstRun(tm, repeat, now)}
		if o["template"] == "briefing" {
			t.Template = "briefing"
		}
		s.data.Tasks = append(s.data.Tasks, t)
	}
	s.saveLocked()
	cp := *t
	s.mu.Unlock()
	s.audit("schedule_task_save", deps.O("id", cp.ID, "name", cp.Name, "repeat", DescribeRepeat(&repeat)), "ok", nil)
	return cp, nil
}

func (s *Service) SetTaskEnabled(id string, enabled bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.find(id)
	if t == nil {
		return false
	}
	t.Enabled = enabled
	if enabled && t.NextRunAt <= s.d.Now() {
		t.NextRunAt = FirstRun(t.Time, t.Repeat, s.d.Now())
	}
	s.saveLocked()
	return true
}

func (s *Service) RemoveTask(id string) bool {
	s.mu.Lock()
	n := len(s.data.Tasks)
	out := s.data.Tasks[:0:0]
	for _, t := range s.data.Tasks {
		if t.ID != id {
			out = append(out, t)
		}
	}
	s.data.Tasks = out
	if len(out) == n {
		s.mu.Unlock()
		return false
	}
	s.saveLocked()
	s.mu.Unlock()
	s.audit("schedule_task_delete", deps.O("id", id), "ok", nil)
	return true
}

func (s *Service) Results() []TaskResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]TaskResult{}, s.data.Results...)
}

func (s *Service) ClearResults() bool {
	s.mu.Lock()
	s.data.Results = []TaskResult{}
	s.saveLocked()
	s.mu.Unlock()
	return true
}

func (s *Service) contextBlock(ctx context.Context, task *SchedTask) string {
	now := s.d.Now()
	d := local(now)
	week := []rune("日一二三四五六")[int(d.Weekday())]
	today := s.d.Desktop.RemindersToday()
	s.mu.Lock()
	var upcoming []string
	for _, t := range s.data.Tasks {
		if t.Enabled && (task == nil || t.ID != task.ID) && DayKey(t.NextRunAt) == DayKey(now) {
			upcoming = append(upcoming, t.Time+" "+t.Name)
		}
	}
	s.mu.Unlock()
	T := s.d.T
	date := fmt.Sprintf("%d/%d/%d", d.Year(), int(d.Month()), d.Day())
	lines := []string{T("electron.common.it-is-now", date, string(week), hhmm(now))}
	if len(today) > 0 {
		rs := make([]string, len(today))
		for i, r := range today {
			rs[i] = "- " + hhmm(r.DueAt) + " " + r.Text
		}
		lines = append(lines, T("electron.common.today-s-reminders", joinLines(rs, "\n")))
	} else {
		lines = append(lines, T("electron.common.no-reminders-today"))
	}
	if len(upcoming) > 0 {
		lines = append(lines, T("electron.common.scheduled-tasks-still-to-run-today", joinLines(upcoming, "、")))
	}
	q := T("electron.common.recent-context")
	if task != nil {
		q = task.Prompt
	}
	if mem, err := s.d.Memory(ctx, q); err == nil && mem != "" {
		lines = append(lines, mem)
	}
	return joinLines(lines, "\n")
}

func joinLines(xs []string, sep string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += sep
		}
		out += x
	}
	return out
}

type RunOpts struct {
	CatchUp bool
	Manual  bool
}

func (s *Service) isRunning(id string) bool {
	for _, r := range s.running {
		if r == id {
			return true
		}
	}
	return false
}

// RunTask：到点 / 补跑 / 手动「立即运行」
func (s *Service) RunTask(ctx context.Context, id string, opts RunOpts) (TaskResult, error) {
	T := s.d.T
	s.mu.Lock()
	t := s.find(id)
	if t == nil {
		s.mu.Unlock()
		return TaskResult{}, &SchedError{"not-found", T("electron.common.task-not-found")}
	}
	if s.isRunning(id) {
		s.mu.Unlock()
		return TaskResult{}, &SchedError{"busy", T("electron.common.task-is-running")}
	}
	s.running = append(s.running, id)
	name, prompt := t.Name, t.Prompt
	snap := *t
	s.mu.Unlock()
	s.broadcast("sched.changed", nil)
	t0 := s.d.Now()
	var catchUp *bool
	if opts.CatchUp {
		v := true
		catchUp = &v
	}
	cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	text, err := func() (string, error) {
		block := s.contextBlock(cctx, &snap)
		out, err := s.d.Complete(cctx, []deps.Msg{
			{Role: "system", Content: T("electron.common.you-are-the-desktop-companion-on-the-user", name) +
				T("electron.common.give-the-result-directly-don-t-ask-questions") + block},
			{Role: "user", Content: prompt},
		})
		if err != nil {
			return "", err
		}
		out = deps.Trim(out)
		if out == "" {
			return "", errors.New(T("electron.common.the-model-returned-no-content"))
		}
		return out, nil
	}()
	cancel()
	res := TaskResult{ID: s.d.NewID(), TaskID: snap.ID, Name: name, At: s.d.Now(), CatchUp: catchUp}
	s.mu.Lock()
	if err == nil {
		res.OK, res.Text = true, text
		t.LastStatus = "ok"
		t.LastError = nil
	} else {
		msg := err.Error()
		res.Text = msg
		t.LastStatus = "error"
		t.LastError = &msg
	}
	for i, r := range s.running {
		if r == id {
			s.running = append(s.running[:i:i], s.running[i+1:]...)
			break
		}
	}
	s.mu.Unlock()
	if err == nil {
		s.deliver(res)
	} else {
		s.d.Logger.Warn("定时任务失败", "name", name, "error", res.Text)
	}
	s.mu.Lock()
	t.LastRunAt = &t0
	rs := append([]TaskResult{res}, s.data.Results...)
	if len(rs) > MaxResults {
		rs = rs[:MaxResults]
	}
	s.data.Results = rs
	s.saveLocked()
	s.mu.Unlock()
	result := "ok"
	if !res.OK {
		result = "error"
	}
	ms := s.d.Now() - t0
	s.audit("schedule_task_run", deps.O("id", snap.ID, "name", name, "manual", opts.Manual, "catchUp", opts.CatchUp), result, &ms)
	return res, nil
}

// deliver：对话窗口（始终）+ 气泡 / 系统通知；免打扰时不打扰
func (s *Service) deliver(r TaskResult) {
	s.broadcast("sched.result", r)
	if s.IsQuiet() {
		return
	}
	short := r.Text
	if deps.Len16(r.Text) > 90 {
		short = deps.Slice0(r.Text, 88) + "…"
	}
	added := ""
	if r.CatchUp != nil && *r.CatchUp {
		added = s.d.T("electron.common.added")
	}
	s.d.Desktop.Notify(deps.Notice{Kind: "reminder", Title: r.Name, Body: short,
		Text: s.d.T("{0}{1}：{2}", added, r.Name, short)})
	deps.AvatarGesture(s.d.Events, "wave")
}

// Start：错过的任务 12 小时内补跑一次（8 秒后），其余排到下一次；之后每 30 秒 tick
func (s *Service) Start() {
	s.mu.Lock()
	if s.timer != nil {
		s.mu.Unlock()
		return
	}
	now := s.d.Now()
	var catchUp []string
	for _, t := range s.data.Tasks {
		if !t.Enabled || t.NextRunAt > now {
			continue
		}
		if now-t.NextRunAt <= CatchUpMs {
			catchUp = append(catchUp, t.ID)
		} else {
			t.LastStatus = "skipped"
		}
		t.NextRunAt = NextOccurrence(t.Repeat, t.NextRunAt, now)
	}
	if len(s.data.Tasks) > 0 {
		s.saveLocked()
	}
	s.timer = time.NewTicker(TickMs * time.Millisecond)
	stop := make(chan struct{})
	s.stopCh = stop
	tk := s.timer
	s.mu.Unlock()
	for _, id := range catchUp {
		id := id
		time.AfterFunc(catchUpDelay, func() {
			_, _ = s.RunTask(context.Background(), id, RunOpts{CatchUp: true})
		})
	}
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				s.Tick(context.Background())
			}
		}
	}()
}

func (s *Service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		close(s.stopCh)
	}
	s.timer = nil
}

func (s *Service) Tick(ctx context.Context) {
	now := s.d.Now()
	s.mu.Lock()
	var due []*SchedTask
	for _, t := range s.data.Tasks {
		if t.Enabled && t.NextRunAt <= now && !s.isRunning(t.ID) {
			due = append(due, t)
		}
	}
	s.mu.Unlock()
	for _, t := range due {
		s.mu.Lock()
		t.NextRunAt = NextOccurrence(t.Repeat, t.NextRunAt, now)
		s.saveLocked()
		id := t.ID
		s.mu.Unlock()
		_, _ = s.RunTask(ctx, id, RunOpts{})
	}
	if _, err := s.MaybeProactive(ctx, false); err != nil {
		s.d.Logger.Warn("主动聊天失败", err.Error())
	}
}

// NoteActivity：用户在对话窗口发了消息
func (s *Service) NoteActivity() {
	s.mu.Lock()
	s.lastChatAt = s.d.Now()
	s.mu.Unlock()
}

type Gate struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason"`
}

func (s *Service) ProactiveGate() Gate {
	T := s.d.T
	s.mu.Lock()
	p := s.data.Settings.Proactive
	st := s.data.Proactive
	lastChat := s.lastChatAt
	s.mu.Unlock()
	now := s.d.Now()
	if !p.Enabled {
		return Gate{false, T("electron.common.off")}
	}
	if s.IsQuiet() {
		return Gate{false, T("electron.common.do-not-disturb")}
	}
	if !InQuiet(QuietHours{Enabled: true, Start: p.ActiveStart, End: p.ActiveEnd}, now) {
		return Gate{false, T("electron.common.outside-active-hours", p.ActiveStart, p.ActiveEnd)}
	}
	f := FREQ[p.Frequency]
	count := 0
	if st.Day == DayKey(now) {
		count = st.Count
	}
	if count >= f.PerDay {
		return Gate{false, T("electron.common.already-chatted-times-today", count)}
	}
	if now-st.LastAt < int64(f.GapMin)*60_000 {
		return Gate{false, T("electron.common.too-soon-since-the-last-chat")}
	}
	if now-lastChat < int64(p.SkipIfChattedMin)*60_000 {
		return Gate{false, T("electron.common.you-were-just-chatting")}
	}
	if s.d.Ports != nil && s.d.Ports.IdleSeconds() > 600 {
		return Gate{false, T("electron.common.you-re-away-from-the-computer")}
	}
	return Gate{true, ""}
}

// MaybeProactive：返回 ""（不说话）或说出的那句话
func (s *Service) MaybeProactive(ctx context.Context, force bool) (string, error) {
	s.mu.Lock()
	if s.proactiveBusy {
		s.mu.Unlock()
		return "", nil
	}
	s.mu.Unlock()
	if !force && !s.ProactiveGate().OK {
		return "", nil
	}
	if !force && s.d.Rand() > 0.08 {
		return "", nil
	}
	s.mu.Lock()
	s.proactiveBusy = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.proactiveBusy = false
		s.mu.Unlock()
	}()
	T := s.d.T
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	block := s.contextBlock(cctx, nil)
	out, err := s.d.Complete(cctx, []deps.Msg{
		{Role: "system", Content: T("electron.common.you-are-a-companion-on-the-user-s") +
			T("electron.common.output-only-that-one-line-under-25-words") + block},
		{Role: "user", Content: T("electron.common.the-user-has-been-quiet-for-a-while")},
	})
	if err != nil {
		return "", err
	}
	text := deps.TrimSlice(out, 120)
	if text == "" {
		return "", nil
	}
	now := s.d.Now()
	s.mu.Lock()
	st := s.data.Proactive
	c := 0
	if st.Day == DayKey(now) {
		c = st.Count
	}
	s.data.Proactive = proactiveState{Day: DayKey(now), Count: c + 1, LastAt: now}
	s.saveLocked()
	s.mu.Unlock()
	s.d.Desktop.Notify(deps.Notice{Kind: "message", Title: s.d.AppName, Text: text})
	deps.AvatarEmotion(s.d.Events, "happy")
	deps.AvatarGesture(s.d.Events, "wave")
	s.broadcast("sched.proactive", map[string]any{"text": text, "at": now})
	s.audit("proactive_chat", deps.O("manual", force), "ok", nil)
	return text, nil
}

type State struct {
	Settings  SchedSettings `json:"settings"`
	Tasks     []SchedTask   `json:"tasks"`
	Running   []string      `json:"running"`
	QuietNow  bool          `json:"quietNow"`
	Deferred  int           `json:"deferred"`
	Proactive struct {
		Today  int   `json:"today"`
		LastAt int64 `json:"lastAt"`
		Gate   Gate  `json:"gate"`
	} `json:"proactive"`
}

func (s *Service) State() State {
	now := s.d.Now()
	var out State
	s.mu.Lock()
	out.Settings = s.data.Settings
	out.Tasks = s.tasksLocked()
	out.Running = append([]string{}, s.running...)
	st := s.data.Proactive
	s.mu.Unlock()
	out.QuietNow = s.IsQuiet()
	out.Deferred = s.d.Desktop.DeferredCount()
	if st.Day == DayKey(now) {
		out.Proactive.Today = st.Count
	}
	out.Proactive.LastAt = st.LastAt
	out.Proactive.Gate = s.ProactiveGate()
	return out
}

func (s *Service) audit(tool string, args any, result string, ms *int64) {
	s.d.Desktop.Append(deps.AuditEntry{Tool: tool, Args: args, Decision: "user", Result: result, Ms: ms, Source: "scheduler"})
}

func (s *Service) broadcast(ch string, payload any) {
	if s.d.Events != nil {
		s.d.Events.Publish(ch, payload)
	}
}

// ProactiveNow：设置页「试一下」；没想到说什么时 SchedError('empty')
func (s *Service) ProactiveNow(ctx context.Context) (string, error) {
	t, err := s.MaybeProactive(ctx, true)
	if err != nil {
		return "", err
	}
	if t == "" {
		return "", &SchedError{"empty", s.d.T("electron.common.couldn-t-think-of-what-to-say-this")}
	}
	return t, nil
}

// BriefingPrompt：每日简报默认提示词（用时再翻译）
func BriefingPrompt(T i18n.Translate) string {
	return T("electron.common.write-me-a-briefing-for-today-start-with") +
		T("electron.common.then-give-one-or-two-thoughtful-tips-based")
}
