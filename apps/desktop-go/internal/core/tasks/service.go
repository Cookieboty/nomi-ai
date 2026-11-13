package tasks

// 持续任务服务（TaskService）：组合存储、运行时、执行者与投递，供契约处理函数（tasks.*）使用。

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
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
	// Events：事件触发：事件源由各模块注册（RegisterSource）
	Events  *EventHub
	sources []*EventSource
	exec    map[string]Executor
	// reconcilers：对外动作的自动核对，按能力名注册
	reconcilers map[string]Reconciler
	// mcpTool：在线 MCP 工具是否只读（授权校验：mcp.read 只能给只读工具）
	mcpTool connections.McpToolLookup
	// reconciling：启动后的自动核对（单测等它结束）
	reconciling sync.WaitGroup
	// changeMu / changeFns：tasks.changed 的进程内订阅
	changeMu  sync.Mutex
	changeFns map[int]func(id string)
	changeN   int
}

// OnChange：任务有变化时回调（与 tasks.changed 事件同时发）。回调可能在运行时持锁时触发：
// 不要在回调里同步回到运行时（Get / Command 等），转到别的 goroutine 再做。
func (s *Service) OnChange(fn func(id string)) func() {
	s.changeMu.Lock()
	defer s.changeMu.Unlock()
	if s.changeFns == nil {
		s.changeFns = map[int]func(string){}
	}
	s.changeN++
	k := s.changeN
	s.changeFns[k] = fn
	return func() {
		s.changeMu.Lock()
		delete(s.changeFns, k)
		s.changeMu.Unlock()
	}
}

func (s *Service) emitChanged(id string) {
	if s.d.Emit != nil {
		s.d.Emit("tasks.changed", map[string]string{"id": id})
	}
	s.changeMu.Lock()
	fns := make([]func(string), 0, len(s.changeFns))
	for _, fn := range s.changeFns {
		fns = append(fns, fn)
	}
	s.changeMu.Unlock()
	for _, fn := range fns {
		fn(id)
	}
}

// TriggerError：事件触发器不合法（契约里映射成 TASKS_BAD_TRIGGER）
type TriggerError struct{ Msg string }

func (e *TriggerError) Error() string { return e.Msg }

// Code：bad_trigger
func (e *TriggerError) Code() string { return "bad_trigger" }

// GrantError：授权里的连接能力不合法（契约里映射成 TASKS_BAD_GRANT）
type GrantError struct{ Msg string }

func (e *GrantError) Error() string { return e.Msg }

// Code：bad_grant
func (e *GrantError) Code() string { return "bad_grant" }

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
	s := &Service{d: d, exec: map[string]Executor{}, reconcilers: map[string]Reconciler{}}
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
		OnChange: func(t Task) {
			s.emitChanged(t.ID)
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
		Changed: s.emitChanged,
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
	// 自动核对要查网络：放到单独的 goroutine，不挡启动、不在运行时的持有者里
	s.reconciling.Add(1)
	go func() {
		defer s.reconciling.Done()
		s.reconcileAll()
	}()
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

// TraceView 是契约 tasks.trace：每次执行的运行轨迹（按时间先后），外加正在跑的那次写到一半的正文与工具。
// attemptId / lines 仍是最近一次执行的（旧调用方只看它）。没有任务或还没有执行时都为空。
func (s *Service) TraceView(id string) map[string]any {
	rec := s.Get(id)
	if rec == nil || len(rec.Attempts) == 0 {
		return map[string]any{"attemptId": nil, "lines": []map[string]any{}, "attempts": []map[string]any{}, "live": nil}
	}
	attempts := make([]map[string]any, 0, len(rec.Attempts))
	var last []map[string]any
	for _, a := range rec.Attempts {
		lines := s.Store.Trace(id, a.ID)
		if lines == nil {
			lines = []map[string]any{}
		}
		last = lines
		item := map[string]any{"attemptId": a.ID, "cause": a.Cause.Kind, "status": a.Status, "startedAt": a.StartedAt, "lines": lines}
		if a.Cause.Note != nil {
			item["note"] = *a.Cause.Note
		}
		if a.EndedAt != nil {
			item["endedAt"] = *a.EndedAt
		}
		attempts = append(attempts, item)
	}
	var live any
	if lv, ok := s.exec[rec.Task.Executor.Kind].(interface {
		LiveView(taskID string) map[string]any
	}); ok {
		if v := lv.LiveView(id); v != nil {
			live = v
		}
	}
	return map[string]any{"attemptId": rec.Attempts[len(rec.Attempts)-1].ID, "lines": last, "attempts": attempts, "live": live}
}

// Steer 是契约 tasks.steer：后台任务正在跑时，把用户在子任务侧栏里说的话插进这次执行（下一步并进上下文）。
// 不在跑、执行者不支持、或这一步已经不收插入消息时 false，界面改成排队，做完后按追问再跑。
func (s *Service) Steer(id, text string) bool {
	rec := s.Get(id)
	if rec == nil || rec.Task.Status != StatusRunning || strings.TrimSpace(text) == "" {
		return false
	}
	st, ok := s.exec[rec.Task.Executor.Kind].(interface {
		Steer(taskID, text string) bool
	})
	return ok && st.Steer(id, text)
}

// FollowUpImage：追问带的一张图片（base64，可带 data: 前缀）
type FollowUpImage struct {
	Mime string `json:"mime"`
	Data string `json:"data"`
}

// MaxFollowUpImages：一次追问最多带几张图
const MaxFollowUpImages = 8

// FollowUp 是契约 tasks.followUp：上一次执行结束后，带着用户的追问（和图片）把同一件事再跑一次（新的一次执行，
// 结果照常写回来源对话）。只支持 Nomi 执行者；正在跑时返回 busy。
func (s *Service) FollowUp(id, text string, images ...FollowUpImage) CmdResult {
	body := strings.TrimSpace(text)
	rec := s.Get(id)
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	if rec.Task.Executor.Kind != "nomi" || (body == "" && len(images) == 0) {
		return CmdResult{Reason: "illegal"}
	}
	if body == "" {
		body = "(see the attached images)"
		if s.d.T != nil {
			body = s.d.T("electron.common.task-follow-up-images-only")
		}
	}
	files, err := s.saveFollowUpImages(id, images)
	if err != nil {
		if s.d.Log != nil {
			s.d.Log.Warn("tasks follow-up images", err.Error())
		}
		return CmdResult{Reason: "illegal"}
	}
	res := s.Runtime.Command(id, Command{Type: "follow_up", Feedback: body, Images: files})
	if !res.OK {
		for _, f := range files {
			_ = os.Remove(f)
		}
	}
	return res
}

var imageExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

// saveFollowUpImages：追问的图片写进 <Root>/attachments/<任务 id>/（执行开始时读回来交给模型）。
func (s *Service) saveFollowUpImages(id string, images []FollowUpImage) ([]string, error) {
	if len(images) == 0 {
		return nil, nil
	}
	if len(images) > MaxFollowUpImages {
		images = images[:MaxFollowUpImages]
	}
	dir := filepath.Join(s.d.Root, "attachments", safeName(id))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	out := []string{}
	for _, im := range images {
		ext, ok := imageExt[strings.ToLower(im.Mime)]
		if !ok {
			return nil, fmt.Errorf("unsupported image type %q", im.Mime)
		}
		data := im.Data
		if i := strings.Index(data, ";base64,"); strings.HasPrefix(data, "data:") && i > 0 {
			data = data[i+len(";base64,"):]
		}
		raw, err := base64.StdEncoding.DecodeString(data)
		if err != nil || len(raw) == 0 {
			return nil, errors.New("bad image data")
		}
		p := filepath.Join(dir, fmt.Sprintf("%d-%d%s", s.d.Now(), len(out), ext))
		if err := os.WriteFile(p, raw, 0o600); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

var unsafeName = regexp.MustCompile(`[^\w-]`)

func safeName(id string) string { return unsafeName.ReplaceAllString(id, "_") }

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
	Priority       *string      `json:"priority,omitempty"`
	Category       *string      `json:"category,omitempty"`
}

// Create：连接能力不合法时返回 *GrantError；事件触发器不合法时返回 *TriggerError
func (s *Service) Create(in CreateRequest, createdBy string) (Task, error) {
	// Nomi 任务用「带工具的 Nomi」的预设模型（对话用的同一条路由），不单独指定（#239）：
	// 契约里的 model 不落盘，免得任务里留着一个其实不生效的「指定模型」
	if in.Executor.Kind == "nomi" {
		in.Executor.Model = nil
	}
	if err := s.checkGrant(in.Grant.Level, in.Grant.Connections); err != nil {
		return Task{}, err
	}
	if err := s.checkTrigger(in.Trigger, in.Grant.Connections, in.Grant.Paths); err != nil {
		return Task{}, err
	}
	return s.Runtime.CreateChecked(CreateInput{Title: in.Title, Goal: in.Goal,
		Origin:  Origin{ConversationID: in.ConversationID, CreatedBy: createdBy, CreatedAt: s.d.Now()},
		Trigger: in.Trigger, Executor: in.Executor, Grant: in.Grant, Budget: in.Budget, Acceptance: in.Acceptance,
		Priority: in.Priority, Category: in.Category})
}

// DelegatedInput：createDelegated 的入参
type DelegatedInput struct {
	Title          string
	Goal           string
	ConversationID *string
	Executor       ExecutorSpec // kind: cli | nomi
	Level          int          // 2 | 3 | 4
	Paths          []string
	// Category：缺省 coding
	Category string
	// Priority：urgent | high | medium | low；空 = 不设
	Priority string
	// Acceptance：auto（缺省，做完直接收下）/ user（等你验收）；派给 Nomi 的总是 auto
	Acceptance string
}

func priorityOf(p string) *string {
	if slices.Contains(TaskPriorities, p) {
		return ptr(p)
	}
	return nil
}

// CreateDelegated：对话里 delegate_to_cli 后台派出的任务（docs/features/scheduling-calendar.md）：用户已在对话里确认过这次委派；
// 编程助手默认直接在工作目录里改（指定了别的分支做基线时在 worktree 里），做完自动收下结果（Acceptance 可传 user 改成等你验收）；
// 瞬时错误重试一次；创建后立即排队。
// 派给 Nomi 的（executor: nomi）：放宽时长与 token、不设每日费用上限，自动验收（结果直接回对话）。
func (s *Service) CreateDelegated(i DelegatedInput) (Task, error) {
	clis := []string{}
	if i.Executor.Kind == "cli" {
		cli := ""
		if i.Executor.Cli != nil {
			cli = *i.Executor.Cli
		}
		clis = []string{cli}
	}
	paths := i.Paths
	if paths == nil {
		paths = []string{}
	}
	category := i.Category
	if category == "" {
		category = "coding"
	}
	via := "delegate"
	budget := &BudgetInput{MaxRetries: ptr(1)}
	// 委派出去的任务做完自动收下（结果直接回对话 / 卡片上给「查看改动」）；要人工验收的在入参里明确传 user
	acceptance := "auto"
	if i.Acceptance == "user" {
		acceptance = "user"
	}
	task, err := s.Runtime.CreateChecked(CreateInput{Title: i.Title, Goal: i.Goal,
		Origin:     Origin{ConversationID: i.ConversationID, CreatedBy: "nomi", CreatedAt: s.d.Now(), Via: &via},
		Trigger:    Trigger{Kind: "manual"},
		Executor:   i.Executor,
		Category:   ptr(category),
		Priority:   priorityOf(i.Priority),
		Grant:      Grant{Level: i.Level, Paths: paths, Connections: []ConnectionGrant{}, Clis: &clis},
		Budget:     budget,
		Acceptance: acceptance,
	})
	if err != nil {
		return Task{}, err
	}
	s.Runtime.Command(task.ID, Command{Type: "runNow"})
	if rec := s.Runtime.Get(task.ID); rec != nil {
		return rec.Task, nil
	}
	return task, nil
}

func delegateAnnouncedMsg(attemptID string) string { return "delegate_announced:" + attemptID }

// Announced：委派任务的这次结果有没有回报过来源对话（记在事件日志里，重启后不重复回报）
func (s *Service) Announced(id, attemptID string) bool {
	msg := delegateAnnouncedMsg(attemptID)
	for _, e := range s.Store.Journal(id) {
		if e.T == "note" && e.Msg == msg {
			return true
		}
	}
	return false
}

// ConversationOwns：对话里委派出去的任务做完、这次结果已经回报到来源对话：之后由对话处理（追问 = 退回重做、
// 收下结果接着做、在结果卡片里应用改动），灵动岛与 Agent 看板不再把它当成「等你验收」
func (s *Service) ConversationOwns(t Task) bool {
	if t.Status != StatusAwaitingAccept || t.Origin.Via == nil || *t.Origin.Via != "delegate" ||
		t.Origin.ConversationID == nil || *t.Origin.ConversationID == "" || t.LastAttemptID == nil {
		return false
	}
	return s.Announced(t.ID, *t.LastAttemptID)
}

func (s *Service) MarkAnnounced(id, attemptID string) {
	_ = s.Store.Append(id, JournalEntry{T: "note", At: s.d.Now(), Msg: delegateAnnouncedMsg(attemptID), AttemptID: attemptID})
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

// Command：改授权时校验连接能力（*GrantError）与事件触发器（*TriggerError）；核对时关掉还开着的 intent
func (s *Service) Command(id string, c Command) (CmdResult, error) {
	if c.Type == "grant" {
		g := Grant{}
		if c.Grant != nil {
			g = *c.Grant
		}
		if err := s.checkGrant(g.Level, g.Connections); err != nil {
			return CmdResult{}, err
		}
		if rec := s.Runtime.Get(id); rec != nil {
			if err := s.checkTrigger(rec.Task.Trigger, g.Connections, g.Paths); err != nil {
				return CmdResult{}, err
			}
		}
	}
	if c.Type == "reconcile" {
		return s.userReconcile(id, c.Outcome), nil
	}
	return s.Runtime.Command(id, c), nil
}

// ValidateGrant：授权里的连接能力：在目录里、等级够、资源写明（docs/features/scheduling-calendar.md）；合法返回 ""
func (s *Service) ValidateGrant(level int, conns []ConnectionGrant) string {
	g := make([]connections.Grant, 0, len(conns))
	for _, c := range conns {
		g = append(g, connections.Grant{ConnectionID: c.ConnectionID, Capabilities: c.Capabilities, Resources: c.Resources})
	}
	return connections.ValidateConnectionGrants(g, level, s.mcpTool)
}

func (s *Service) checkGrant(level int, conns []ConnectionGrant) error {
	if msg := s.ValidateGrant(level, conns); msg != "" {
		return &GrantError{Msg: msg}
	}
	return nil
}

func (s *Service) Remove(id string) bool {
	ok := s.Runtime.Remove(id)
	if ok {
		s.Events.Remove(id)
		// Removal has no state transition: notify after runtime and event cleanup,
		// outside their locks so observers can immediately reload the list.
		s.emitChanged(id)
	}
	return ok
}

// WorktreeApply：落地结果（contract tasks.applyWorktree 的输出）。Branch：改动多（或拷不回去的）提交到的新分支
type WorktreeApply struct {
	Applied    []string `json:"applied"`
	Skipped    []string `json:"skipped"`
	Conflicted []string `json:"conflicted"`
	Denied     []string `json:"denied"`
	Branch     string   `json:"branch,omitempty"`
}

// ApplyWorktree：验收卡片上的「回填」：最近一次执行在 worktree 里的改动落地（delegate.LandWorktree：改动少拷回
// 当前工作区、按当前授权检查每个目标，多则提交到新分支），然后拆掉 worktree；没有可回填的返回 nil。
func (s *Service) ApplyWorktree(id string, apply func(iso CliIsolation, files []string, title string) WorktreeApply) *WorktreeApply {
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
	iso.BaseBranch = strOr(rec.Task.Executor.BaseBranch)
	r := apply(iso, files, rec.Task.Title)
	_ = s.Store.Append(id, JournalEntry{T: "note", At: s.d.Now(), AttemptID: a.ID,
		Msg: fmt.Sprintf("applied:%d conflicted:%d denied:%d branch:%s", len(r.Applied), len(r.Conflicted), len(r.Denied), r.Branch)})
	return &r
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
