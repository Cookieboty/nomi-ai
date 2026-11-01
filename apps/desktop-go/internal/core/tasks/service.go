package tasks

// 持续任务服务，对应 src/tasks/TaskService.ts：组合存储、运行时、执行者与投递，供契约处理函数（tasks.*）使用。

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

type ServiceDeps struct {
	Root   string
	Log    Logger
	Emit   func(event string, payload any)
	Notify NotifyFunc
	T      i18n.Translate
	// 旧的提醒 / 定时代理任务（只读并入任务页）；缺省不列
	LegacyReminders func() []LegacyReminder
	LegacySched     func() []LegacySchedTask
	// QuietUntil：免打扰结束时刻；不在免打扰时 nil
	QuietUntil func() *int64
	Now        func() int64
	SetTimer   func(fn func(), ms int64) func()
}

type Service struct {
	d       ServiceDeps
	Outbox  *Outbox
	Store   *Store
	Runtime *Runtime
	// Events：事件触发（§6）：事件源由各模块注册（RegisterSource）
	Events  *EventHub
	sources []*EventSource
	exec    map[string]Executor
}

// TriggerError：事件触发器不合法（契约里映射成 TASKS_BAD_TRIGGER）
type TriggerError struct{ Msg string }

func (e *TriggerError) Error() string { return e.Msg }

// Code：bad_trigger
func (e *TriggerError) Code() string { return "bad_trigger" }

type ListResult struct {
	Tasks  []Task       `json:"tasks"`
	Legacy []LegacyItem `json:"legacy"`
}

const shortLen = 90

func short(s string) string {
	if utf8.RuneCountInString(s) <= shortLen {
		return s
	}
	r := []rune(s)
	return string(r[:shortLen-2]) + "…"
}

func newID(prefix string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func NewService(d ServiceDeps) *Service {
	if d.T == nil {
		d.T = i18n.Identity
	}
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.SetTimer == nil {
		d.SetTimer = func(fn func(), ms int64) func() {
			t := time.AfterFunc(time.Duration(ms)*time.Millisecond, fn)
			return func() { t.Stop() }
		}
	}
	s := &Service{d: d, exec: map[string]Executor{}}
	s.Store = NewStore(d.Root, d.Log)
	s.Outbox = NewOutbox(OutboxDeps{File: filepath.Join(d.Root, "outbox.json"), Now: d.Now, SetTimer: d.SetTimer,
		NewID: func() string { return newID("o") }, QuietUntil: d.QuietUntil, Log: d.Log,
		Send: func(title, text string) (err error) {
			defer func() {
				if p := recover(); p != nil {
					err = fmt.Errorf("%v", p)
				}
			}()
			if d.Notify != nil {
				d.Notify(title, text)
			}
			return nil
		},
		MergedText: func(items []OutboxItem) (string, string) {
			ids, titles := map[string]bool{}, []string{}
			seen := map[string]bool{}
			for _, x := range items {
				ids[x.TaskID] = true
				if !seen[x.TaskTitle] {
					seen[x.TaskTitle] = true
					titles = append(titles, x.TaskTitle)
				}
			}
			return d.T("electron.common.persistent-tasks"),
				d.T("electron.common.persistent-task-merged", len(ids), short(strings.Join(titles, "、")))
		},
		Delivered: func(items []OutboxItem) {
			for _, x := range items {
				_ = s.Store.Append(x.TaskID, JournalEntry{T: "note", At: d.Now(), Msg: "delivered:" + x.ID})
			}
		},
	})
	if d.Notify != nil {
		s.exec["notify"] = NewNotifyExecutor(d.Notify)
	}
	s.Runtime = NewRuntime(RuntimeDeps{
		Store:     s.Store,
		Executors: s.exec,
		Now:       d.Now,
		SetTimer:  d.SetTimer,
		NewID:     newID,
		Log:       d.Log,
		Deliver:   s.deliver,
		DailyBudgetExceeded: func(t Task, attempts []Attempt, now int64) bool {
			return t.Budget.MaxCostUsdPerDay != nil && SpentToday(attempts, now) >= *t.Budget.MaxCostUsdPerDay
		},
		OnChange: func(t Task) {
			if d.Emit != nil {
				d.Emit("tasks.changed", map[string]string{"id": t.ID})
			}
			// 在运行时的持有者里：不能同步回到 FireEvent，排队给 hub
			if s.Events != nil {
				s.Events.SyncAsync(t)
			}
		},
	})
	s.Events = NewEventHub(EventHubDeps{
		Root:    filepath.Join(d.Root, "events"),
		Sources: func() []*EventSource { return s.sources },
		Fire:    s.Runtime.FireEvent,
		Changed: func(id string) {
			if d.Emit != nil {
				d.Emit("tasks.changed", map[string]string{"id": id})
			}
		},
		LastEventKey: func(id string) string {
			rec := s.Runtime.Get(id)
			if rec == nil || len(rec.Attempts) == 0 {
				return ""
			}
			if k := rec.Attempts[len(rec.Attempts)-1].Cause.EventKey; k != nil {
				return *k
			}
			return ""
		},
		Log:      d.Log,
		Now:      d.Now,
		SetTimer: d.SetTimer,
	})
	return s
}

// RegisterSource：事件源（app / folder / web / github），须在 Start 之前
func (s *Service) RegisterSource(src *EventSource) { s.sources = append(s.sources, src) }

// EventBatch：执行者取这次执行要处理的事件
func (s *Service) EventBatch(taskID string, eventKey *string) []SourceEvent {
	if eventKey == nil || *eventKey == "" {
		return []SourceEvent{}
	}
	return s.Events.Batch(taskID, *eventKey)
}

// RegisterExecutor：nomi、cli 由各自模块注册（须在 Start 之前）
func (s *Service) RegisterExecutor(kind string, ex Executor) { s.exec[kind] = ex }

func (s *Service) Start() {
	s.Outbox.Start()
	s.Runtime.Start()
	s.Events.Start(s.Runtime.List())
}

func (s *Service) Stop() {
	s.Events.Stop()
	s.Runtime.Stop()
	s.Outbox.Stop()
}

func (s *Service) List() ListResult {
	ts := s.Runtime.List()
	sort.SliceStable(ts, func(i, j int) bool { return ts[i].UpdatedAt > ts[j].UpdatedAt })
	var rs []LegacyReminder
	var ss []LegacySchedTask
	if s.d.LegacyReminders != nil {
		rs = s.d.LegacyReminders()
	}
	if s.d.LegacySched != nil {
		ss = s.d.LegacySched()
	}
	return ListResult{Tasks: ts, Legacy: LegacyItems(rs, ss)}
}

func (s *Service) Get(id string) *Record { return s.Runtime.Get(id) }

func (s *Service) Inbox() []Task {
	out := []Task{}
	for _, t := range s.Runtime.List() {
		for _, st := range InboxStatuses {
			if t.Status == st {
				out = append(out, t)
				break
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (s *Service) Journal(id string) []JournalEntry {
	if s.Runtime.Get(id) == nil {
		return []JournalEntry{}
	}
	return s.Store.Journal(id)
}

// CreateRequest 对应契约 tasks.create 的入参
type CreateRequest struct {
	Title          string       `json:"title"`
	Goal           string       `json:"goal"`
	ConversationID *string      `json:"conversationId,omitempty"`
	Trigger        Trigger      `json:"trigger"`
	Executor       ExecutorSpec `json:"executor"`
	Grant          Grant        `json:"grant"`
	Budget         *BudgetInput `json:"budget,omitempty"`
	Acceptance     string       `json:"acceptance,omitempty"`
}

// Create：事件触发器不合法时返回 *TriggerError
func (s *Service) Create(in CreateRequest, createdBy string) (Task, error) {
	if err := s.checkTrigger(in.Trigger, in.Grant.Connections, in.Grant.Paths); err != nil {
		return Task{}, err
	}
	return s.Runtime.Create(CreateInput{Title: in.Title, Goal: in.Goal,
		Origin:  Origin{ConversationID: in.ConversationID, CreatedBy: createdBy, CreatedAt: s.d.Now()},
		Trigger: in.Trigger, Executor: in.Executor, Grant: in.Grant, Budget: in.Budget, Acceptance: in.Acceptance}), nil
}

// Update：没有这个任务返回 nil, nil；事件触发器不合法返回 *TriggerError
func (s *Service) Update(id string, p Patch) (*Task, error) {
	rec := s.Runtime.Get(id)
	if rec == nil {
		return nil, nil
	}
	cur := rec.Task
	if p.Trigger != nil {
		tr := *p.Trigger
		// 改成自动执行是放宽授权：只能经 SetMode（dangerous，界面里先确认），这里保留原来的模式
		if tr.Kind == "event" {
			mode := "observe"
			if cur.Trigger.Kind == "event" && cur.Trigger.Mode != nil {
				mode = *cur.Trigger.Mode
			}
			tr.Mode = &mode
			p.Trigger = &tr
		}
		if err := s.checkTrigger(tr, cur.Grant.Connections, cur.Grant.Paths); err != nil {
			return nil, err
		}
	}
	return s.Runtime.Patch(id, p), nil
}

// SetMode：事件任务：只记录 ↔ 自动执行（改成自动执行是放宽授权，契约里是 dangerous）
func (s *Service) SetMode(id, mode string) *Task {
	rec := s.Runtime.Get(id)
	if rec == nil || rec.Task.Trigger.Kind != "event" {
		return nil
	}
	tr := rec.Task.Trigger
	tr.Mode = &mode
	return s.Runtime.Patch(id, Patch{Trigger: &tr})
}

// ValidateTrigger：事件触发器：事件源存在、过滤条件合法且在授权范围里；不合法时返回原因
func (s *Service) ValidateTrigger(tr Trigger, conns []ConnectionGrant, paths []string) string {
	if tr.Kind != "event" {
		return ""
	}
	if conns == nil {
		conns = []ConnectionGrant{}
	}
	if paths == nil {
		paths = []string{}
	}
	return s.Events.Validate(Task{Trigger: tr, Grant: Grant{Connections: conns, Paths: paths}})
}

func (s *Service) checkTrigger(tr Trigger, conns []ConnectionGrant, paths []string) error {
	if msg := s.ValidateTrigger(tr, conns, paths); msg != "" {
		return &TriggerError{Msg: msg}
	}
	return nil
}

func (s *Service) Command(id string, c Command) CmdResult { return s.Runtime.Command(id, c) }

func (s *Service) Remove(id string) bool {
	ok := s.Runtime.Remove(id)
	if ok {
		s.Events.Remove(id)
	}
	return ok
}

// WorktreeApply：回填结果（contract tasks.applyWorktree 的输出）
type WorktreeApply struct {
	Applied    []string `json:"applied"`
	Skipped    []string `json:"skipped"`
	Conflicted []string `json:"conflicted"`
	Denied     []string `json:"denied"`
}

// ApplyWorktree：验收卡片上的「回填」（§5.4、§7.2）：把最近一次执行在 worktree 里的改动拷回主工作区。
// apply 做实际拷贝（delegate.ApplyWorktreeToMain + 按当前授权检查每个目标）；没有可回填的返回 nil。
func (s *Service) ApplyWorktree(id string, apply func(iso CliIsolation, files []string) WorktreeApply) *WorktreeApply {
	rec := s.Runtime.Get(id)
	if rec == nil {
		return nil
	}
	var a *Attempt
	for i := len(rec.Attempts) - 1; i >= 0; i-- {
		x := rec.Attempts[i]
		if x.Carrier != nil && x.Carrier.Worktree != nil && x.Result != nil {
			a = &x
			break
		}
	}
	if a == nil || a.Carrier.GitRoot == nil {
		return nil
	}
	files := []string{}
	for _, art := range a.Result.Artifacts {
		if art.Kind == "file" {
			files = append(files, art.Ref)
		}
	}
	c := a.Carrier
	iso := CliIsolation{Kind: "worktree", Cwd: *c.Worktree, SourceCwd: *c.Worktree, GitRoot: *c.GitRoot, WorktreePath: *c.Worktree}
	if c.Cwd != nil {
		iso.Cwd = *c.Cwd
	}
	if c.SourceCwd != nil {
		iso.SourceCwd = *c.SourceCwd
	}
	r := apply(iso, files)
	_ = s.Store.Append(id, JournalEntry{T: "note", At: s.d.Now(), AttemptID: a.ID,
		Msg: fmt.Sprintf("applied:%d conflicted:%d denied:%d", len(r.Applied), len(r.Conflicted), len(r.Denied))})
	return &r
}

// SpentToday：今天（本机时区）各次执行的已知费用合计；费用未知的不计入（§9）
func SpentToday(attempts []Attempt, now int64) float64 {
	d := time.UnixMilli(now)
	start := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.Local).UnixMilli()
	sum := 0.0
	for _, a := range attempts {
		if a.StartedAt >= start && a.Usage.CostUsd != nil {
			sum += *a.Usage.CostUsd
		}
	}
	return sum
}

func (s *Service) deliver(t Task, what string, a *Attempt) {
	if what == "result" && t.Executor.Kind == "notify" {
		return
	}
	T := s.d.T
	var text string
	switch what {
	case "result":
		sum := ""
		if a != nil && a.Result != nil {
			sum = a.Result.Summary
		}
		text = T("electron.common.persistent-task-result", t.Title, short(sum))
	case "need_user":
		detail := T("electron.common.persistent-task-waiting")
		if t.Wait != nil && t.Wait.Detail != nil {
			detail = *t.Wait.Detail
		}
		text = T("electron.common.persistent-task-needs-you", t.Title, short(detail))
	case "error":
		msg := ""
		if t.LastError != nil {
			msg = t.LastError.Message
		}
		text = T("electron.common.persistent-task-failed", t.Title, short(msg))
	case "expired":
		text = T("electron.common.persistent-task-expired", t.Title)
	case "reconcile":
		text = T("electron.common.persistent-task-reconcile", t.Title)
	case "auto_paused":
		text = T("electron.common.persistent-task-auto-paused", t.Title)
	default:
		return
	}
	// 先进投递队列（先存再发、合并、免打扰）
	s.Outbox.Push(t.ID, t.Title, T("electron.common.persistent-tasks"), text)
}
