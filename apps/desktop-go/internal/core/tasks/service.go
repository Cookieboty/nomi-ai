package tasks

// 持续任务服务，对应 src/tasks/TaskService.ts：组合存储、运行时、执行者与投递，供契约处理函数（tasks.*）使用。

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
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
	Now             func() int64
	SetTimer        func(fn func(), ms int64) func()
}

type Service struct {
	d       ServiceDeps
	Store   *Store
	Runtime *Runtime
	exec    map[string]Executor
}

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
		OnChange: func(t Task) {
			if d.Emit != nil {
				d.Emit("tasks.changed", map[string]string{"id": t.ID})
			}
		},
	})
	return s
}

// RegisterExecutor：nomi、cli 由各自模块注册（须在 Start 之前）
func (s *Service) RegisterExecutor(kind string, ex Executor) { s.exec[kind] = ex }

func (s *Service) Start() { s.Runtime.Start() }
func (s *Service) Stop()  { s.Runtime.Stop() }

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

func (s *Service) Create(in CreateRequest, createdBy string) Task {
	return s.Runtime.Create(CreateInput{Title: in.Title, Goal: in.Goal,
		Origin:  Origin{ConversationID: in.ConversationID, CreatedBy: createdBy, CreatedAt: s.d.Now()},
		Trigger: in.Trigger, Executor: in.Executor, Grant: in.Grant, Budget: in.Budget, Acceptance: in.Acceptance})
}

func (s *Service) Update(id string, p Patch) *Task { return s.Runtime.Patch(id, p) }

func (s *Service) Command(id string, c Command) CmdResult { return s.Runtime.Command(id, c) }

func (s *Service) Remove(id string) bool { return s.Runtime.Remove(id) }

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
	if s.d.Notify != nil {
		s.d.Notify(T("electron.common.persistent-tasks"), text)
	}
}
