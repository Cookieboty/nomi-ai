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
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/sidechat"
)

type ServiceDeps struct {
	Root       string
	Log        Logger
	Emit       func(event string, payload any)
	Notify     NotifyFunc
	NotifyTask NotifyTaskFunc
	T          i18n.Translate
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
	// handoffMu / handoffs：前台转后台按「来源轮次 + 会话」只接受一次接管（#413）：同一 reqId 重试复用同一个任务。
	// 只记最近几次（重启后靠任务快照里的 SourceID 复用）
	handoffMu  sync.Mutex
	handoffs   map[string]*handoffSlot
	handoffSeq []string // 插入顺序（先进先出淘汰）
	// resumeMu / resumeFns：接管后前台流中止、后台重新接收（启动态落盘失败时不能在停下前台之后才失败，#413）
	resumeMu  sync.Mutex
	resumeFns []resumeEntry
	resumeN   int
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

// InputError：入参校验失败（契约里映射成 BAD_INPUT）
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

type ListResult struct {
	Tasks  []Task               `json:"tasks"`
	Legacy []LegacyItem         `json:"legacy"`
	Queue  map[string]QueueInfo `json:"queue,omitempty"`
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
	s := &Service{d: d, exec: map[string]Executor{}, reconcilers: map[string]Reconciler{},
		handoffs: map[string]*handoffSlot{}}
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
		SendBatch: func(items []OutboxItem, title, text string) (err error) {
			defer func() {
				if p := recover(); p != nil {
					err = fmt.Errorf("%v", p)
				}
			}()
			taskID := ""
			if len(items) > 0 {
				taskID = items[0].TaskID
				for _, x := range items[1:] {
					if x.TaskID != taskID {
						taskID = ""
						break
					}
				}
			}
			if d.NotifyTask != nil {
				d.NotifyTask(taskID, title, text)
			} else if d.Notify != nil {
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
	if d.NotifyTask != nil {
		s.exec["notify"] = NewNotifyExecutorWithTask(d.NotifyTask)
	} else if d.Notify != nil {
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
	// 运行时只停调度、不改任务状态（进程退出时留下开放的外部动作，靠重启后对账）。这里不再等执行者：
	// 等空不能靠改任务状态（把运行中落盘成 cancelled 会毁掉重启后的对账），而执行者本身也不受 Stop 约束
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
	q := s.Runtime.QueueSnapshot()
	if len(q) == 0 {
		q = nil
	}
	return ListResult{Tasks: ts, Legacy: LegacyItems(rs, ss), Queue: q}
}

func (s *Service) Get(id string) *Record { return s.Runtime.Get(id) }

func (s *Service) Inbox() []Task {
	out := []Task{}
	for _, t := range s.Runtime.List() {
		if NeedsUserAction(t, s.ConversationOwns(t)) {
			out = append(out, t)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

// ArchiveAllEnded：一键归档所有已结束（且不需用户处理）的任务，返回本次归档数量
func (s *Service) ArchiveAllEnded() int {
	n := 0
	for _, t := range s.Runtime.List() {
		if t.ArchivedAt != nil || !IsTerminal(t.Status) || NeedsUserAction(t, s.ConversationOwns(t)) {
			continue
		}
		if res := s.Runtime.Command(t.ID, Command{Type: "archive", Outcome: "user"}); res.OK {
			n++
		}
	}
	return n
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
// 结果照常写回来源对话）。支持 Nomi 与 CLI 执行者（仅拒绝 notify）；正在跑或排队中时返回 busy。
func (s *Service) FollowUp(id, text string, images ...FollowUpImage) CmdResult {
	return s.FollowUpWithOptions(id, text, false, images...)
}

// FollowUpWithOptions：支持持续自动化任务选择同步更新长期目标（updateGoal=true 时合并追加进 Task.Goal）
func (s *Service) FollowUpWithOptions(id, text string, updateGoal bool, images ...FollowUpImage) CmdResult {
	body := strings.TrimSpace(text)
	rec := s.Get(id)
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	if rec.Task.Executor.Kind == "notify" || (body == "" && len(images) == 0) {
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
	outcome := ""
	if updateGoal && strings.TrimSpace(text) != "" {
		outcome = "update_goal"
	}
	res := s.Runtime.Command(id, Command{Type: "follow_up", Feedback: body, Images: files, Outcome: outcome})
	if !res.OK {
		for _, f := range files {
			_ = os.Remove(f)
		}
	}
	return res
}

// AppendQueued：任务处于排队中（queued）时追加本次运行补充指令与图片，不重置排队位置，也不破坏 FollowUp 的 busy 语义
func (s *Service) AppendQueued(id, text string, images ...FollowUpImage) CmdResult {
	body := strings.TrimSpace(text)
	rec := s.Get(id)
	if rec == nil {
		return CmdResult{Reason: "not_found"}
	}
	if rec.Task.Executor.Kind == "notify" || rec.Task.Status != StatusQueued || (body == "" && len(images) == 0) {
		return CmdResult{Reason: "illegal"}
	}
	if body == "" && len(images) > 0 {
		body = "(see the attached images)"
		if s.d.T != nil {
			body = s.d.T("electron.common.task-follow-up-images-only")
		}
	}
	files, err := s.saveFollowUpImages(id, images)
	if err != nil {
		if s.d.Log != nil {
			s.d.Log.Warn("tasks appendQueued images", err.Error())
		}
		return CmdResult{Reason: "illegal"}
	}
	res := s.Runtime.Command(id, Command{Type: "update_pending_note", Feedback: body, Images: files})
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
	complete := false
	defer func() {
		if !complete {
			for _, p := range out {
				_ = os.Remove(p)
			}
		}
	}()
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
		// O_EXCL + 随机文件名：并发 / 同毫秒的追问互不覆盖，拒绝清理只删自己的附件。
		f, err := os.CreateTemp(dir, "followup-*"+ext)
		if err != nil {
			return nil, err
		}
		out = append(out, f.Name())
		_, writeErr := f.Write(raw)
		closeErr := f.Close()
		if writeErr != nil {
			return nil, writeErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
	}
	complete = true
	return out, nil
}

// readableImageData：附图数据是合法的 base64（可带 data: 前缀），解码后非空
func readableImageData(data string) bool {
	d := strings.TrimSpace(data)
	if i := strings.Index(d, ";base64,"); strings.HasPrefix(d, "data:") && i > 0 {
		d = d[i+len(";base64,"):]
	}
	raw, err := base64.StdEncoding.DecodeString(d)
	return err == nil && len(raw) > 0
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
	// Nomi 任务可指定合法网关模型（<provider>/<model>）；裸名等非法值忽略不落盘，走预设「带工具的 Nomi」路由
	if in.Executor.Kind == "nomi" && in.Executor.Model != nil {
		if ref, ok := sidechat.ModelRef(sidechat.ModelRolePrefix + strings.TrimSpace(*in.Executor.Model)); ok {
			in.Executor.Model = ptr(ref)
		} else {
			in.Executor.Model = nil
		}
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
// agent 默认直接在工作目录里改（指定了别的分支做基线时在 worktree 里），做完自动收下结果（Acceptance 可传 user 改成等你验收）；
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
	budget := &BudgetInput{MaxRetries: ptr(DelegatedMaxRetries)}
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

// HandoffInput：前台长程对话主动转后台的任务入参
type HandoffInput struct {
	// SourceID：来源轮次（reqId）；同一轮重试复用同一个任务
	SourceID        string
	ConversationID  string
	ProjectID       string
	Title           string
	UserGoal        string
	PartialContent  string
	ProgressSummary string
	HistoryContext  string
	Cwd             string
	Paths           []string
	// Images：这一轮用户已经发给前台、获准交给模型的附图（原图）；后台首轮同样带上（#414）。
	// 读不回来或超出上限时整个接管失败，不改头换成纯文字
	Images []FollowUpImage
}

// HandoffError：转后台没有接管（前台流要保留，#413 / #414）。Code 给契约错误码：
// storage_error（创建 / 启动态没落盘）、image_unavailable（附图读不回来）、bad_input（入参不合法）
type HandoffError struct {
	Code string
	Msg  string
}

func (e *HandoffError) Error() string { return e.Msg }

// handoffSlot：同一轮（来源轮次 + 来源会话）的接管只发生一次
type handoffSlot struct {
	done chan struct{}
	id   string
	err  *HandoffError
}

// resumeEntry：重新接收的订阅（键稳定，取消时只删自己）
type resumeEntry struct {
	k  int
	fn func(ts Task)
}

// OnHandoffResume：转后台接管后前台流被中止 / 启动态落盘失败后的重新接收（前台把已产出的内容接回去继续）。
// 返回取消订阅
func (s *Service) OnHandoffResume(fn func(ts Task)) func() {
	s.resumeMu.Lock()
	s.resumeN++
	e := resumeEntry{k: s.resumeN, fn: fn}
	s.resumeFns = append(s.resumeFns, e)
	s.resumeMu.Unlock()
	return func() {
		s.resumeMu.Lock()
		defer s.resumeMu.Unlock()
		keep := s.resumeFns[:0:0]
		for _, x := range s.resumeFns {
			if x.k != e.k {
				keep = append(keep, x)
			}
		}
		s.resumeFns = keep
	}
}

func (s *Service) handoffResumed(ts Task) {
	s.resumeMu.Lock()
	fns := append([]resumeEntry{}, s.resumeFns...)
	s.resumeMu.Unlock()
	for _, fn := range fns {
		fn.fn(ts)
	}
}

// handoffSource：接管键（也是落进任务快照 Origin.SourceID 的来源标识）：同一来源会话的同一轮 reqId 只接管一次。
// 会话与轮次分隔用 "|"：请求 id 由内核生成（newID("req")），不含 "|"，不会误配
func handoffSource(session, reqID string) string {
	if reqID == "" {
		return ""
	}
	return session + "|" + reqID
}

// CreateHandoff：把前台进行中的长程任务转入后台异步继续执行（via: "handoff"）。
// 完成后通过 delegate.completed 回写来源对话，并进入自动验收与 24h 自动归档轨道。
//
// 只有后台确实接下了（任务已落盘、启动态已落盘、已在队列里合法排队）才返回任务并通知前台可以停下原流
// （OnHandoffResume）；创建 / 启动态保存失败返回 *HandoffError（storage_error），前台流不动、已产出内容保留。
// 同一 SourceID 的重试复用同一个任务，重复点击只接管一次（#413）。
func (s *Service) CreateHandoff(in HandoffInput) (Task, error) {
	goal := strings.TrimSpace(in.UserGoal)
	if goal == "" {
		goal = strings.TrimSpace(in.Title)
	}
	if goal == "" {
		return Task{}, &HandoffError{Code: "bad_input", Msg: "handoff userGoal is required"}
	}
	if len(in.Images) > MaxFollowUpImages {
		return Task{}, &HandoffError{Code: "bad_input", Msg: fmt.Sprintf("too many images (max %d)", MaxFollowUpImages)}
	}
	for _, im := range in.Images {
		if _, ok := imageExt[strings.ToLower(im.Mime)]; !ok || !readableImageData(im.Data) {
			return Task{}, &HandoffError{Code: "image_unavailable", Msg: "handoff image is not readable"}
		}
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		runes := []rune(goal)
		if len(runes) > 36 {
			title = string(runes[:36]) + "…"
		} else {
			title = goal
		}
	}
	var ctxParts []string
	if hc := strings.TrimSpace(in.HistoryContext); hc != "" {
		ctxParts = append(ctxParts, "【转入前对话上下文】\n"+hc)
	}
	if ps := strings.TrimSpace(in.ProgressSummary); ps != "" {
		ctxParts = append(ctxParts, "【转入前已执行的工具与步骤摘要】\n"+ps)
	}
	if pc := strings.TrimSpace(in.PartialContent); pc != "" {
		ctxParts = append(ctxParts, "【转入前已生成给用户的部分正文（勿重复复述，继续完成后续部分即可）】\n"+pc)
	}
	var ctxPtr *string
	if len(ctxParts) > 0 {
		joined := strings.Join(ctxParts, "\n\n")
		ctxPtr = &joined
	}
	var convPtr *string
	if strings.TrimSpace(in.ConversationID) != "" {
		cid := strings.TrimSpace(in.ConversationID)
		convPtr = &cid
	}
	// 接管键：同一轮（来源会话 + reqId）的重试复用同一个任务；没有 reqId 的调用各自是一次接管
	key := ""
	if in.SourceID != "" {
		session := ""
		if convPtr != nil {
			session = *convPtr
		}
		key = handoffSource(session, in.SourceID)
	}
	var slot *handoffSlot
	joined := false
	settled := false
	s.handoffMu.Lock()
	if key != "" {
		if prev := s.handoffs[key]; prev != nil {
			slot = prev
			select {
			case <-slot.done:
				// 这一轮已经接管过了：直接复用结果（不重新创建、不重新排队、不再通知一次停流）
				settled = true
			default:
				joined = true
			}
		}
	}
	if slot == nil {
		slot = &handoffSlot{done: make(chan struct{})}
		if key != "" {
			s.handoffs[key] = slot
		}
	}
	s.handoffMu.Unlock()

	if settled {
		if slot.err != nil {
			return Task{}, slot.err
		}
		if rec := s.Runtime.Get(slot.id); rec != nil {
			return rec.Task, nil
		}
		return Task{}, &HandoffError{Code: "storage_error", Msg: "handoff task disappeared"}
	}
	if joined {
		// 同一轮正在接管：等它的结果（不重复创建，也不重复排队）
		<-slot.done
		if slot.err != nil {
			return Task{}, slot.err
		}
		if rec := s.Runtime.Get(slot.id); rec != nil {
			return rec.Task, nil
		}
		return Task{}, &HandoffError{Code: "storage_error", Msg: "handoff task disappeared"}
	}

	task, herr := s.runHandoff(in, goal, title, ctxPtr, convPtr, key)
	target := task.ID
	if herr != nil && herr.Code == "storage_error" {
		// 没接上：同一轮的重试重新来过
		target = ""
	}
	s.handoffMu.Lock()
	slot.id, slot.err = target, herr
	if herr != nil && key != "" && s.handoffs[key] == slot {
		// 失败的结果（storage_error / image_unavailable）也让同一轮的等待者拿到，再忘掉：之后的重试重新来过
		delete(s.handoffs, key)
		for i, k := range s.handoffSeq {
			if k == key {
				s.handoffSeq = append(s.handoffSeq[:i], s.handoffSeq[i+1:]...)
				break
			}
		}
	} else if herr == nil && key != "" {
		s.handoffSeq = append(s.handoffSeq, key)
		for len(s.handoffSeq) > maxHandoffSlots {
			old := s.handoffSeq[0]
			s.handoffSeq = s.handoffSeq[1:]
			if s.handoffs[old] == slot {
				delete(s.handoffs, old)
			}
		}
	}
	close(slot.done)
	s.handoffMu.Unlock()
	if herr != nil {
		return Task{}, herr
	}
	return task, nil
}

// maxHandoffSlots：内存里记住多少次已经完成的接管（再往前的落在任务快照的 SourceID 里，照样能复用）
const maxHandoffSlots = 256

// reusableHandoff：这个接管键已有任务（同一内存里的重试 / 重启后重试）：只复用没被别的来源接管的那个
func (s *Service) reusableHandoff(key string, conv *string) bool {
	if key == "" {
		return false
	}
	for _, t := range s.Runtime.List() {
		if t.Origin.SourceID == nil || *t.Origin.SourceID != key || !IsConversationBacked(t) {
			continue
		}
		if t.Origin.Via == nil || *t.Origin.Via != "handoff" {
			continue
		}
		if t.Origin.ConversationID == nil || conv == nil || *t.Origin.ConversationID != *conv {
			continue
		}
		if s.Runtime.Handoffable(t.ID, key) {
			return true
		}
	}
	return false
}

func (s *Service) runHandoff(in HandoffInput, goal, title string, ctxPtr *string, conv *string, key string) (Task, *HandoffError) {
	toolset := "conversation"
	ex := ExecutorSpec{
		Kind:    "nomi",
		Tools:   &[]string{},
		Toolset: &toolset,
		Brief: &Brief{
			DoneWhen: "沿着转入前进度完成用户原始目标，并给出完整清晰的最终结果。",
			Context:  ctxPtr,
		},
	}
	if in.Cwd != "" {
		cwd := in.Cwd
		ex.Cwd = &cwd
	}
	if in.ProjectID != "" {
		pid := in.ProjectID
		ex.Project = &pid
	}
	paths := append([]string(nil), in.Paths...)
	if paths == nil {
		paths = []string{}
	}
	via := "handoff"
	origin := Origin{ConversationID: conv, CreatedBy: "user", CreatedAt: s.d.Now(), Via: &via}
	budget := &BudgetInput{MaxRetries: ptr(DelegatedMaxRetries)}

	// 重试：同一个任务身份（同一轮已经建过的任务，没被别的来源接管过就接着用它）
	var task Task
	reopened := ""
	if key != "" {
		for _, t := range s.Runtime.List() {
			if t.Origin.SourceID == nil || *t.Origin.SourceID != key || t.Origin.Via == nil || *t.Origin.Via != "handoff" ||
				t.Origin.ConversationID == nil || conv == nil || *t.Origin.ConversationID != *conv || t.ArchivedAt != nil {
				continue
			}
			// 还没跑过（上次接管没接上，落到 idle）：直接接着接管；
			// 上次已经跑完（快照里仍有这个来源轮次，内存里的接管记录可能重启后丢了）：同一个任务身份原地重跑，不新建
			if !ranBefore(t) {
				task = t
				break
			}
			res := s.Runtime.ReopenHandoff(t.ID, key)
			if res.OK {
				task = t
				reopened = t.ID
				break
			} else if res.Reason == "storage_error" {
				s.logWarn("tasks handoff reopen", res.Reason+" "+t.ID)
				return Task{}, &HandoffError{Code: "storage_error", Msg: "handoff task was not reopened"}
			}
		}
	}
	// 复用的任务已经跑过一轮：它的附图目录里是上一轮的图，这次的接管没接上就得整个收掉（不能连上一轮一起删）
	priorAttach := ""
	if reopened != "" {
		priorAttach = filepath.Join(s.d.Root, "attachments", safeName(reopened))
	}
	cleanup := func() {
		s.removeHandoffAttachments(task.ID)
		if priorAttach != "" {
			if err := os.MkdirAll(priorAttach, 0o700); err != nil {
				s.logWarn("tasks handoff release", err.Error())
			}
		}
	}
	created := task.ID == ""
	if created {
		// 落盘的来源标识就是查找用的接管键（来源会话 + reqId）：重启后内存里的接管记录没了，
		// 靠快照里的这个键找回同一个任务身份，不新建（#413）
		if key != "" {
			src := key
			origin.SourceID = &src
		}
		t, err := s.Runtime.CreateChecked(CreateInput{
			Title:      title,
			Goal:       goal,
			Origin:     origin,
			Trigger:    Trigger{Kind: "manual"},
			Executor:   ex,
			Grant:      Grant{Level: 4, Paths: paths, Connections: []ConnectionGrant{}},
			Budget:     budget,
			Acceptance: "auto",
		})
		if err != nil {
			s.logWarn("tasks handoff create", err.Error())
			return Task{}, &HandoffError{Code: "storage_error", Msg: "handoff task was not saved"}
		}
		task = t
	}
	// 没接上：已经停下的执行者不会再写附件，这时才删这次接管放出去的附图与空目录（#413 / #414）。
	// 失败不是靠 storage_error 判断的：故障注入下「停下执行者」本身也落不了盘（这时不会有人再跑它），
	// 同样按没接上收回，等执行者停下才返回
	settle := func() bool {
		// 停执行者、放回 idle；有执行者在跑时等它真正停下再删附件（没在跑时立即返回）
		res, await := s.Runtime.ReleaseUnstarted(task.ID, 0)
		ok := await()
		cleanup()
		if !ok {
			s.logWarn("tasks handoff release", "executor did not stop "+task.ID)
		}
		return res.OK
	}
	fail := func(code, msg string) (Task, *HandoffError) {
		// 留下的是一个从没执行过的空任务：删掉，看板上不多一张坏卡
		if created {
			s.discardHandoffTask(task.ID)
		}
		settle()
		return Task{}, &HandoffError{Code: code, Msg: msg}
	}
	// 这次接管的落盘没能同步成（被拒或落盘失败）：作废这次开始、停下已经启动的执行者，再收掉附件。
	// 失败可能来自几处的联动（取得名额、执行者启动时的回报……），任何一处没同步成就不能当接手成功。
	// gen：已经启动的那个执行者的编号（取得名额时带出来）；停执行者这一步也落不了盘时按它再停一次
	var gen int
	reject := func(code, msg string) (Task, *HandoffError) {
		if gen > 0 {
			res, await := s.Runtime.DiscardHandoffRun(task.ID, gen)
			if !res.OK && res.Reason != "not_found" {
				s.logWarn("tasks handoff discard", res.Reason+" "+task.ID)
			}
			if !await() {
				s.logWarn("tasks handoff release", "executor did not stop "+task.ID)
			}
		}
		return fail(code, msg)
	}

	// 附图：写进任务的附件目录，首轮执行读回来交给模型（#414）；写不进来就不接管
	if len(in.Images) > 0 {
		files, err := s.saveFollowUpImages(task.ID, in.Images)
		if err != nil {
			s.logWarn("tasks handoff images", err.Error())
			// 保存失败时自己可能已经建了空的附件目录：一并收掉
			return reject("image_unavailable", "handoff image is not readable")
		}
		if !s.Runtime.SetHandoffImages(task.ID, files) {
			s.logWarn("tasks handoff images", "not saved "+task.ID)
			return reject("storage_error", "handoff task was not saved")
		}
	}

	// 接管：登记待跑并落盘
	if res := s.Runtime.HandoffTakeover(task.ID, key); !res.OK {
		s.logWarn("tasks handoff takeover", res.Reason+" "+task.ID)
		return reject("storage_error", "handoff task was not accepted")
	}

	// 确认启动：排队立即取得名额时，启动态也要落盘（没落盘 = 没启动，前台流要保留）。
	// 没落盘时带回来的 Gen 是已经启动（但没落盘）的执行者编号：要先停掉它才能删附件。
	// 已经落定的失败（启动态没落盘后已经放回 idle）只等执行者停下，不按 Gen 再停一次（那会把别的状态改掉）
	if started := s.Runtime.EnsureStarted(task.ID); !started.OK {
		s.logWarn("tasks handoff start", started.Reason+" "+task.ID)
		if started.Gen > 0 {
			gen = started.Gen
		}
		return reject("storage_error", "handoff task was not started")
	}
	rec := s.Runtime.Get(task.ID)
	if rec == nil {
		s.logWarn("tasks handoff verify", "task disappeared "+task.ID)
		return Task{}, &HandoffError{Code: "storage_error", Msg: "handoff task disappeared"}
	}
	// 排队 / 开跑 / 已经跑完（执行者很快就结束、还在等验收）都算接下：发起那一轮已经交出去了
	if !acceptedByBackground(rec.Task.Status) {
		s.logWarn("tasks handoff verify", "status "+rec.Task.Status+" "+task.ID)
		return reject("storage_error", "handoff task was not accepted")
	}
	// 后台已接受接管：现在才让前台停下原流（已产出的内容由前台接回这一轮）
	s.handoffResumed(rec.Task)
	return rec.Task, nil
}

// acceptedByBackground：转后台已经接下（不再停在 idle 等开始）
func acceptedByBackground(status string) bool {
	switch status {
	case StatusQueued, StatusRunning, StatusAwaitingAccept, StatusWaitingUser, StatusNeedsReconcile, StatusDone, StatusFailed, StatusCancelled, StatusExpired:
		return true
	}
	return false
}

// ranBefore：已经执行过（跑完 / 失败 / 取消过）
func ranBefore(t Task) bool { return IsTerminal(t.Status) || t.LastRunAt != nil }

// removeHandoffAttachments：只删这个任务自己的附件目录 / 文件（任务留下，重试还会往里写）。
// 调用前执行者必须已经停下（停了才删，不会被删完又写回来）
func (s *Service) removeHandoffAttachments(id string) {
	if id == "" {
		return
	}
	if err := os.RemoveAll(filepath.Join(s.d.Root, "attachments", safeName(id))); err != nil {
		s.logWarn("tasks handoff release", err.Error())
	}
}

// discardHandoffTask：接管没成功、留下一个从没执行过的任务：删掉，不在看板上多一张坏卡
func (s *Service) discardHandoffTask(id string) {
	if id == "" {
		return
	}
	rec := s.Runtime.Get(id)
	if rec == nil || rec.Task.Status != StatusIdle {
		return
	}
	if res := s.Runtime.Command(id, Command{Type: "cancel"}); !res.OK {
		return
	}
	s.Remove(id)
}

func (s *Service) logWarn(what, msg string) {
	if s.d.Log != nil {
		s.d.Log.Warn(what, "error", msg)
	}
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

// Update：没有这个任务返回 nil, nil；事件触发器不合法返回 *TriggerError；入参模型/来源不合法返回 *InputError
func (s *Service) Update(id string, p Patch) (*Task, error) {
	rec := s.Runtime.Get(id)
	if rec == nil {
		return nil, nil
	}
	cur := rec.Task
	if cur.Executor.Kind == "nomi" && p.Model.Set && p.Model.Value != nil {
		if trimmed := strings.TrimSpace(*p.Model.Value); trimmed != "" {
			if _, ok := sidechat.ModelRef(sidechat.ModelRolePrefix + trimmed); !ok {
				return nil, &InputError{Msg: "invalid model ref"}
			}
		}
	}
	if cur.Executor.Kind == "cli" && p.Source.Set && p.Source.Value != nil {
		if src := strings.TrimSpace(*p.Source.Value); src != "" && src != "local" && src != "official" && src != "thirdParty" {
			return nil, &InputError{Msg: "invalid source"}
		}
	}
	if cur.Executor.Kind == "cli" && cur.Executor.PresetID != nil && *cur.Executor.PresetID != "" &&
		(cur.Executor.Cli == nil || *cur.Executor.Cli == "") &&
		(p.Source.Set || p.AccountID.Set || (p.PresetID.Set && (p.PresetID.Value == nil || strings.TrimSpace(*p.PresetID.Value) == ""))) {
		if res, ok := s.exec["cli"].(interface{ ResolvePresetCli(string) string }); ok {
			if cliName := res.ResolvePresetCli(*cur.Executor.PresetID); cliName != "" {
				p.ResolvedCli = &cliName
			}
		}
	}
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
