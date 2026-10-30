package desktop

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DesktopService.ts：桌面能力的总装（授权、审计、撤销、回收站、提醒、拖入总结）

type Role = string // chat | agent-tools | summary

// Emitter 应用事件总线；surface 非空表示只发给该窗口（D-B6-12：Go 路由暂按订阅广播）
// Emitter 推送事件（surface 非空时只发给该窗口），返回是否有订阅者收到
type Emitter func(event string, payload any, surface string) bool

// RuntimeProvider resolveProvider 的返回
type RuntimeProvider struct {
	ID, Name, BaseURL, Model string
}

// RuntimeHooks 对应 DesktopRuntimeHooks
type RuntimeHooks struct {
	Complete        func(messages []map[string]string, role Role) (string, error)
	ResolveProvider func(role Role) *RuntimeProvider
	LookupProvider  func(id string) *RuntimeProvider
}

// Windows 对应 DesktopWindows（Main=桌面角色窗口是否存在）
type Windows struct {
	Main          func() bool
	IsVisible     func() bool
	ShowInactive  func()
	OpenChat      func()
	MascotHidden  func() bool
	SummonMascot  func()
	ReleaseMascot func()
	// ChatOpen：对话窗口在屏幕上（确认请求只发给它，不打扰桌面角色）
	ChatOpen func() bool
	Island   func(n IslandNotice) bool
}

// Ports 对应 DesktopPorts 中用到的部分
type Ports struct {
	Home             string
	PickDirectory    func(title, buttonLabel, defaultPath string) string
	NotifySupported  func() bool
	ShowNotification func(title, body string, onClick func())
	// ClipboardRead / ClipboardWrite = ports.clipboard（desktop.tools() 的 clipboard_*）
	ClipboardRead  func() (string, error)
	ClipboardWrite func(text string) error
}

type NotifyPolicy interface {
	Quiet() bool
	QuietEndsAt() float64
}

// DesktopNotice 对应 DesktopNotice
type DesktopNotice struct {
	Kind, Title, Text, Body, Status, Endpoint string
	Passive                                   bool
	// Bubble = n.bubble（DesktopBubble 去掉 text：kind / voice …，按键序并入气泡负载）；nil = 无。
	Bubble *util.Obj
}

type MissedItem struct {
	ID    string  `json:"id"`
	Text  string  `json:"text"`
	DueAt float64 `json:"dueAt"`
}

type Service struct {
	Broker    *PermissionBroker
	Audit     *AuditLog
	Trash     *AppTrash
	Journal   *UndoJournal
	Reminders *reminders.Store

	NotifyPolicy NotifyPolicy

	root    string
	ports   Ports
	emit    Emitter
	runtime *RuntimeHooks
	windows *Windows

	mu               sync.Mutex
	remindersStarted bool
	deferred         []reminders.Reminder
	deferTimer       *time.Timer
	missedQueue      []reminders.Reminder
	pendingSummary   *pendingSlot
}

type pendingSlot struct {
	payload any
	at      float64
}

// PendingEventTTLMs pendingEvents 的 TTL
const PendingEventTTLMs = 60_000

func realpathFor() func(string) (string, error) { return RealpathNative }

// NewService 对应 new DesktopService(root, logger, opts)
func NewService(root string, ports Ports, emit Emitter, denyRoots []string) *Service {
	if emit == nil {
		emit = func(string, any, string) bool { return false }
	}
	s := &Service{root: root, ports: ports, emit: emit}
	s.Broker = NewPermissionBroker(filepath.Join(root, "settings.json"), GuardEnv{
		Home: ports.Home, Platform: Platform(), Realpath: realpathFor(), DenyRoots: denyRoots,
	}, BrokerOpts{})
	s.Audit = NewAuditLog(filepath.Join(root, "audit"), nil)
	s.Trash = NewAppTrash(filepath.Join(root, "trash"), nil)
	s.Journal = NewUndoJournal(filepath.Join(root, "journal.jsonl"), s.Trash, nil)
	s.Reminders = reminders.New(filepath.Join(root, "reminders.json"), nil, nil)
	s.Reminders.OnFire = func(r reminders.Reminder) { s.fireReminder(r) }
	s.Reminders.OnChange(func() { s.broadcast("desktop.p2Changed", map[string]string{"kind": "reminders"}) })
	// Node 在 createP2Tools 里注册；Go 版工具层未落地，先在这里注册（D-B6-11）
	s.Journal.RegisterCustom("reminder-restore", CustomUndo{
		Check: func(p json.RawMessage) string {
			var r reminders.Reminder
			_ = json.Unmarshal(p, &r)
			if s.Reminders.Get(r.ID) != nil {
				return ""
			}
			return "提醒已不存在"
		},
		Apply: func(p json.RawMessage) error {
			var r reminders.Reminder
			if err := json.Unmarshal(p, &r); err != nil {
				return err
			}
			s.Reminders.Restore(r)
			return nil
		},
	})
	func() {
		defer func() {
			if e := recover(); e != nil {
				log.Printf("桌面能力：清理回收站 / 审计日志失败 %v", e)
			}
		}()
		s.Trash.Purge(30)
		s.Audit.Rotate()
	}()
	s.Broker.UI = brokerUI{s}
	s.Broker.OnChange(func() { s.broadcast("desktop.changed", s.State()) })
	return s
}

type brokerUI struct{ s *Service }

func (u brokerUI) Request(req ConfirmRequest) { u.s.sendConfirm(req) }
func (u brokerUI) Cancel(id string) {
	u.s.cancelConfirm(id)
	u.s.rehideMascotIfIdle()
}

func (s *Service) chatOpen() bool {
	return s.windows != nil && s.windows.ChatOpen != nil && s.windows.ChatOpen()
}

// cancelConfirm：确认请求收起（答复 / 超时 / 取消），两边都发，没订阅的界面收不到
func (s *Service) cancelConfirm(id string) {
	s.emit("desktop.confirmCancel", id, "chat")
	s.toMascot("desktop.confirmCancel", id)
}

func (s *Service) AttachRuntime(h *RuntimeHooks) { s.runtime = h }
func (s *Service) AttachWindows(w *Windows)      { s.windows = w }

func (s *Service) main() bool { return s.windows != nil && s.windows.Main != nil && s.windows.Main() }

func (s *Service) mascotHidden() bool {
	return s.windows != nil && s.windows.MascotHidden != nil && s.windows.MascotHidden()
}

func (s *Service) showMain() {
	if s.windows.IsVisible != nil && !s.windows.IsVisible() && s.windows.ShowInactive != nil {
		s.windows.ShowInactive()
	}
}

func (s *Service) rehideMascotIfIdle() {
	if !s.mascotHidden() || len(s.Broker.PendingRequests()) > 0 {
		return
	}
	if s.windows != nil && s.windows.ReleaseMascot != nil {
		s.windows.ReleaseMascot()
	}
}

func (s *Service) broadcast(ch string, payload any) { s.emit(ch, payload, "") }

func (s *Service) toMascot(ch string, payload any) {
	if s.main() {
		s.emit(ch, payload, "mascot")
	}
}

func (s *Service) avatarGesture(name string) {
	s.emit("avatar.event", map[string]string{"type": "gesture", "name": name}, "")
}

func (s *Service) avatarEmotion(name string) {
	s.emit("avatar.event", map[string]string{"type": "emotion", "name": name}, "")
}

// IsMascotSender：调用方是桌面角色窗口（D-B6-4：按 Caller.Surface 判断）
func (s *Service) IsMascotSender(surface string) bool { return s.main() && surface == "mascot" }

// sendConfirm：对话窗口开着 → 只发给对话窗口（授权卡片）；桌面角色被关掉了 → 打开对话窗口
// （窗口挂载后经 desktop.state 补拉）；否则发给桌面角色。请求文件夹只走对话窗口（见 RequestFolder）。
func (s *Service) sendConfirm(req ConfirmRequest) {
	if s.chatOpen() || req.Kind == "scope" {
		log.Printf("桌面工具确认请求 tool=%s danger=%s to=chat", req.Tool, req.Danger)
		s.emit("desktop.confirmRequest", req, "chat")
		return
	}
	if s.mascotHidden() && s.windows != nil && s.windows.OpenChat != nil {
		log.Printf("桌面工具确认请求 tool=%s danger=%s to=chat-open", req.Tool, req.Danger)
		s.windows.OpenChat()
		s.emit("desktop.confirmRequest", req, "chat")
		return
	}
	w := s.main()
	log.Printf("桌面工具确认请求 tool=%s danger=%s hasWindow=%v", req.Tool, req.Danger, w)
	if !w {
		if s.mascotHidden() && s.windows.SummonMascot != nil {
			s.windows.SummonMascot()
		}
		return
	}
	s.showMain()
	s.emit("desktop.confirmRequest", req, "mascot")
	s.avatarGesture("think")
	if req.Danger == "destructive" {
		s.avatarEmotion("surprised")
	} else {
		s.avatarEmotion("relaxed")
	}
}

// Say 在桌面角色气泡里说一句
func (s *Service) Say(text string) { s.toMascot("desktop.bubble", map[string]string{"text": text}) }

// sayWith = say(text, opts)：{ text, ...opts }。
func (s *Service) sayWith(text string, opts *util.Obj) {
	if opts == nil || len(opts.Keys()) == 0 {
		s.Say(text)
		return
	}
	p := util.NewObj("text", text)
	for _, k := range opts.Keys() {
		p.Set(k, opts.Get(k))
	}
	s.toMascot("desktop.bubble", p)
}

// Notify 对应 notify：bubble | island | notification | none
func (s *Service) Notify(n DesktopNotice) string {
	if !s.mascotHidden() && s.main() {
		s.sayWith(n.Text, n.Bubble)
		return "bubble"
	}
	body := n.Body
	if body == "" {
		body = n.Text
	}
	if s.windows != nil && s.windows.Island != nil {
		ok := func() (ok bool) {
			defer func() {
				if e := recover(); e != nil {
					log.Printf("灵动岛通知失败 %v", e)
					ok = false
				}
			}()
			return s.windows.Island(IslandNotice{Kind: n.Kind, Title: n.Title, Body: body, Status: n.Status, Endpoint: n.Endpoint})
		}()
		if ok {
			return "island"
		}
	}
	if n.Passive || (s.NotifyPolicy != nil && s.NotifyPolicy.Quiet()) {
		return "none"
	}
	if s.ports.NotifySupported == nil || !s.ports.NotifySupported() || s.ports.ShowNotification == nil {
		return "none"
	}
	s.ports.ShowNotification(n.Title, body, func() {
		if s.windows != nil && s.windows.OpenChat != nil {
			s.windows.OpenChat()
		}
	})
	return "notification"
}

func reminderArgs(r reminders.Reminder, via string) *OMap {
	a := NewOMap()
	a.Set("id", r.ID)
	a.Set("text", r.Text)
	if via != "" {
		a.Set("via", via)
	}
	return a
}

func (s *Service) fireReminder(r reminders.Reminder) {
	if pol := s.NotifyPolicy; pol != nil && pol.Quiet() {
		s.mu.Lock()
		s.deferred = append(s.deferred, r)
		if s.deferTimer == nil {
			wait := math.Max(1000, pol.QuietEndsAt()-nowMs())
			wait = math.Min(wait, math.Pow(2, 31)-1)
			s.deferTimer = time.AfterFunc(time.Duration(wait)*time.Millisecond, s.FlushDeferred)
		}
		s.mu.Unlock()
		a := reminderArgs(r, "")
		s.Audit.Append(AuditEntry{Tool: "reminder_deferred", Decision: "auto", Result: "ok", Source: "scheduler"}, a)
		return
	}
	s.deliverReminders([]reminders.Reminder{r})
}

func (s *Service) FlushDeferred() {
	s.mu.Lock()
	if s.deferTimer != nil {
		s.deferTimer.Stop()
	}
	s.deferTimer = nil
	items := s.deferred
	s.deferred = nil
	s.mu.Unlock()
	if len(items) == 0 {
		return
	}
	if len(items) > 1 && !s.mascotHidden() {
		s.Say(tr.T("electron.common.reminders-came-in-during-do-not-disturb-here", len(items)))
	}
	s.deliverReminders(items)
}

func (s *Service) DeferredCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.deferred)
}

func (s *Service) deliverReminders(items []reminders.Reminder) {
	w := s.main()
	log.Printf("提醒触发 count=%d hasWindow=%v mascotHidden=%v", len(items), w, s.mascotHidden())
	if !w || s.mascotHidden() {
		s.deliverReminderElsewhere(items)
		return
	}
	s.showMain()
	for _, r := range items {
		s.emit("desktop.reminder", map[string]any{"id": r.ID, "text": r.Text, "dueAt": r.DueAt, "missed": false}, "mascot")
		s.Audit.Append(AuditEntry{Tool: "reminder_fire", Decision: "auto", Result: "ok", Source: "scheduler"}, reminderArgs(r, "bubble"))
	}
	s.avatarGesture("wave")
	s.avatarEmotion("happy")
}

func (s *Service) deliverReminderElsewhere(items []reminders.Reminder) {
	if len(items) == 0 {
		return
	}
	title := tr.T("electron.common.reminder")
	body := items[0].Text
	if len(items) > 1 {
		texts := make([]string, len(items))
		for i, r := range items {
			texts[i] = r.Text
		}
		body = tr.T("electron.common.reminders", len(items), strings.Join(texts, "；"))
	}
	via := s.Notify(DesktopNotice{Kind: "reminder", Status: "attention", Title: title, Text: body})
	if via == "none" {
		log.Printf("提醒没有可用的展示方式（桌面角色已隐藏、灵动岛与系统通知都不可用） count=%d", len(items))
	}
	for _, r := range items {
		res := "ok"
		if via == "none" {
			res = "not_shown"
		}
		s.Audit.Append(AuditEntry{Tool: "reminder_fire", Decision: "auto", Result: res, Source: "scheduler"}, reminderArgs(r, via))
	}
}

func (s *Service) StartReminders() {
	s.mu.Lock()
	if s.remindersStarted {
		s.mu.Unlock()
		return
	}
	s.remindersStarted = true
	s.mu.Unlock()
	missed := s.Reminders.Start()
	s.mu.Lock()
	s.missedQueue = missed
	s.mu.Unlock()
}

func (s *Service) TakeMissed() []MissedItem {
	s.StartReminders()
	s.mu.Lock()
	items := s.missedQueue
	s.missedQueue = nil
	s.mu.Unlock()
	if len(items) > 0 {
		ids := make([]string, len(items))
		for i, r := range items {
			ids[i] = r.ID
		}
		s.Reminders.MarkAnnounced(ids)
		if s.mascotHidden() {
			s.deliverReminderElsewhere(items)
			return []MissedItem{}
		}
		s.avatarGesture("wave")
	}
	out := make([]MissedItem, len(items))
	for i, r := range items {
		out[i] = MissedItem{r.ID, r.Text, r.DueAt}
	}
	return out
}

// ProviderFor 对应 providerFor
func (s *Service) ProviderFor(role Role) *Provider {
	if s.runtime == nil || s.runtime.ResolveProvider == nil {
		return nil
	}
	p := s.runtime.ResolveProvider(role)
	if p == nil {
		return nil
	}
	return &Provider{ID: p.ID, Name: p.Name, Local: IsLocalBaseURL(p.BaseURL)}
}

func (s *Service) summarize(text, instruction string) (string, error) {
	if s.runtime == nil || s.runtime.Complete == nil {
		return "", errString(tr.T("electron.common.ai-runtime-not-ready"))
	}
	return s.runtime.Complete([]map[string]string{
		{"role": "system", "content": instruction},
		{"role": "user", "content": "<file_content trust=\"untrusted\">\n" + text + "\n</file_content>"},
	}, "summary")
}

type errString string

func (e errString) Error() string { return string(e) }

var reTilde = regexp.MustCompile(`^~($|[\\/])`)

// expandHome = expandHome：`~` / `~/…` / `~\…` → 用户目录下的路径；filepath.Join，Windows 上不会混进 `/`
func (s *Service) expandHome(p string) string {
	if reTilde.MatchString(p) {
		return filepath.Join(s.ports.Home, p[1:])
	}
	return p
}

// RequestFolder：工具请求授权文件夹。对话窗口开着时在对话里问（授权建议的文件夹 / 另选 / 拒绝），
// 只有用户要另选时才打开系统的选择框；对话窗口没开时照旧直接打开选择框。"" = 没有授权
func (s *Service) RequestFolder(ctx context.Context, suggested, mode, reason string) string {
	if !s.chatOpen() {
		return s.PickFolder(suggested)
	}
	abs := ""
	if suggested != "" {
		abs = s.expandHome(suggested)
	}
	d, real := s.Broker.RequestScope(abs, mode, reason, ctx)
	switch d {
	case "allowed":
		return real
	case "pick":
		return s.PickFolder(suggested)
	}
	return ""
}

func (s *Service) PickFolder(suggested string) string {
	if s.ports.PickDirectory == nil {
		return ""
	}
	def := ""
	if suggested != "" {
		def = s.expandHome(suggested)
	}
	return s.ports.PickDirectory(tr.T("electron.common.grant-nomi-access-to-this-folder"), tr.T("electron.common.grant"), def)
}

// ToolState state().tools 的元素
type ToolState struct {
	Name   string `json:"name"`
	Danger Danger `json:"danger"`
	Policy Policy `json:"policy"`
	Locked bool   `json:"locked"`
}

// State 对应 state()：{...broker.view(), tools, pending}
type State struct {
	BrokerView
	Tools   []ToolState      `json:"tools"`
	Pending []ConfirmRequest `json:"pending"`
}

func (s *Service) State() State {
	tools := []ToolState{}
	for _, name := range ToolDangerKeys {
		if name == "desktop_permissions" {
			continue
		}
		d := ToolDanger[name]
		tools = append(tools, ToolState{name, d, s.Broker.Policy(name, d), name == "undo_last" || name == "desktop_request_scope" || d == "destructive"})
	}
	p := s.Broker.PendingRequests()
	if p == nil {
		p = []ConfirmRequest{}
	}
	return State{s.Broker.View(), tools, p}
}

type OKCode struct {
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}

var reWS = regexp.MustCompile(`\s+`)

// SummarizeDropped 对应 summarizeDropped
func (s *Service) SummarizeDropped(raw string) OKCode {
	t0 := nowMs()
	say := func(text string) { s.toMascot("desktop.bubble", map[string]string{"text": text}) }
	ms := func() *int64 { v := int64(nowMs() - t0); return &v }
	fail := func(code, text string, path string) OKCode {
		say(text)
		s.avatarEmotion("sad")
		a := NewOMap()
		a.Set("path", path)
		s.Audit.Append(AuditEntry{Tool: "drop_summarize", Decision: "user", Result: code, Ms: ms(), Source: "drop"}, a)
		return OKCode{false, code}
	}
	probe := GuardPath(raw, GuardEnv{
		Scopes: []Scope{{ID: "probe", Path: raw, Mode: "read", Kind: "file", GrantedAt: nowMs()}},
		Home:   s.ports.Home, Platform: Platform(), Realpath: realpathFor(),
	}, GuardOpts{Need: "read"})
	if !probe.OK {
		msg := tr.T("electron.common.i-can-t-open-this-file")
		if probe.Code == "denied" {
			msg = tr.T("electron.common.this-file-is-protected-i-can-t-read")
		}
		return fail(probe.Code, msg, raw)
	}
	if !parse.IsSupported(probe.Real) {
		return fail("unsupported", tr.T("electron.common.i-can-t-read-this-kind-of-file"), raw)
	}
	s.Broker.Grant(probe.Real, "read", "file", true)
	name := lib(Platform()).Basename(probe.Real)
	say(tr.T("electron.common.reading", name))
	s.avatarGesture("think")
	parsed := parse.ParseFile(probe.Real, parse.ParseOptions{})
	if !parsed.OK {
		return fail(parsed.Code, tr.T("electron.common.read-failed", parsed.Message), raw)
	}
	if jsTrim(parsed.Text) == "" {
		return fail("empty", tr.T("electron.common.no-text-found-it-may-be-a-scanned"), raw)
	}
	switch s.Broker.CheckSend(s.ProviderFor("summary"), nil, "") {
	case "local_only":
		return fail("local_only", tr.T("electron.common.only-local-models-can-read-files-is-on"), raw)
	case "user_denied":
		return fail("user_denied", tr.T("electron.common.ok-not-sending"), raw)
	}
	summary, err := SummarizeText(s.summarize, parsed.Text, "bullets", "auto", 250, name)
	if err != nil {
		return fail("llm_error", tr.T("electron.common.summary-failed", err.Error()), raw)
	}
	a := NewOMap()
	a.Set("path", probe.Real)
	prov := ""
	if p := s.ProviderFor("summary"); p != nil {
		prov = p.ID
	}
	s.Audit.Append(AuditEntry{Tool: "drop_summarize", Decision: "user", Result: "ok", Ms: ms(), Source: "drop", Provider: prov}, a)
	short := jsTrim(reWS.ReplaceAllString(summary, " "))
	if u16len(short) > 90 {
		say(tr.T("electron.common.full-text-in-the-chat-window", u16slice(short, 0, 90)))
	} else {
		say(short)
	}
	s.avatarGesture("nod")
	s.avatarEmotion("happy")
	if s.windows != nil {
		if s.windows.OpenChat != nil {
			s.windows.OpenChat()
		}
		payload := map[string]any{"name": name, "path": probe.Real, "summary": summary, "at": nowMs()}
		delivered := s.emit("desktop.summary", payload, "chat")
		s.mu.Lock()
		if delivered { // pendingEvents.offer：送达则作废旧槽，否则留下等窗口挂载时拉取
			s.pendingSummary = nil
		} else {
			s.pendingSummary = &pendingSlot{payload, nowMs()}
		}
		s.mu.Unlock()
	}
	return OKCode{OK: true}
}

// TakePendingSummary pendingEvents.take('summary')
func (s *Service) TakePendingSummary() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.pendingSummary
	s.pendingSummary = nil
	if p == nil || nowMs()-p.at > PendingEventTTLMs {
		return nil
	}
	return p.payload
}

func (s *Service) GrantFolder(mode any) *Scope {
	picked := s.PickFolder("")
	if picked == "" {
		return nil
	}
	m := "read"
	if mode == "read-write" {
		m = "read-write"
	}
	sc := s.Broker.Grant(picked, m, "", false)
	a := NewOMap()
	a.Set("path", sc.Path)
	a.Set("mode", sc.Mode)
	s.userAudit("grant_scope", a, "ok")
	return &sc
}

func (s *Service) RevokeScope(id any) bool {
	sid, ok := id.(string)
	ok = ok && s.Broker.Revoke(sid)
	if ok {
		a := NewOMap()
		a.Set("id", sid)
		s.userAudit("revoke_scope", a, "ok")
	}
	return ok
}

func (s *Service) SetToolPolicy(tool, policy any) bool {
	t, ok := tool.(string)
	if !ok {
		return false
	}
	d, ok := ToolDanger[t]
	if !ok {
		return false
	}
	s.Broker.SetPolicy(t, d, SanitizePolicy(d, policy))
	return true
}

func (s *Service) SetLocalOnly(v any) bool { s.Broker.SetLocalOnly(v == true); return true }
func (s *Service) ResetCloudAcks() bool    { s.Broker.ResetCloudAcks(); return true }

func (s *Service) AuditList(limit any) []json.RawMessage {
	n := 200
	if f, ok := limit.(float64); ok {
		n = int(math.Min(1000, f))
	}
	return s.Audit.List(n)
}

func (s *Service) ClearAudit() bool {
	s.Audit.Clear()
	s.broadcast("desktop.changed", s.State())
	return true
}

func (s *Service) JournalList() []JournalItem { return s.Journal.List(50) }

type UndoResult struct {
	OK     bool   `json:"ok"`
	Undone string `json:"undone,omitempty"`
	Error  string `json:"error,omitempty"`
}

func (s *Service) UndoLast() UndoResult {
	e := s.Journal.Last()
	if e == nil {
		return UndoResult{Error: tr.T("electron.common.nothing-to-undo")}
	}
	if err := s.Journal.Undo(*e); err != nil {
		return UndoResult{Error: err.Error()}
	}
	a := NewOMap()
	a.Set("id", e.ID)
	s.userAudit("undo_last", a, "ok")
	s.broadcast("desktop.changed", s.State())
	return UndoResult{OK: true, Undone: e.Summary}
}

func (s *Service) ResetAll() bool {
	s.Broker.ResetAll()
	s.Audit.Clear()
	return true
}

func (s *Service) userAudit(tool string, args *OMap, result string) {
	s.Audit.Append(AuditEntry{Tool: tool, Decision: "user", Result: result, Source: "settings"}, args)
}

func (s *Service) RemindersList(all any) []reminders.Reminder {
	return s.Reminders.List(all == true, 200)
}

func clipAny(v any, n int) string {
	if s, ok := v.(string); ok {
		return reminders.Clip(s, n)
	}
	return ""
}

// CreateReminder 对应 createReminder；o 为解析后的 JSON 对象
func (s *Service) CreateReminder(o map[string]json.RawMessage) *reminders.Reminder {
	text := reminders.TrimJS(clipAny(jsAny(o["text"]), 500))
	in := reminders.DueInput{}
	if a, ok := jsAny(o["at"]).(string); ok {
		in.At = a
	}
	if m, ok := jsAny(o["inMinutes"]).(float64); ok {
		in.InMinutes = &m
	}
	now := nowMs()
	due, ok := reminders.ResolveDue(in, now)
	if text == "" || !ok || due < now-1000 {
		return nil
	}
	r := s.Reminders.Create(text, due, reminders.SanitizeRepeat(o["repeat"]))
	a := NewOMap()
	a.Set("id", r.ID)
	a.Set("text", r.Text)
	if r.Repeat != nil {
		a.Set("repeat", r.Repeat.Kind)
	}
	s.userAudit("reminder_create", a, "ok")
	return &r
}

func (s *Service) UpdateReminder(id any, o map[string]json.RawMessage) *reminders.Reminder {
	p := reminders.Patch{}
	if t, ok := jsAny(o["text"]).(string); ok {
		c := reminders.Clip(t, 500)
		p.Text = &c
	}
	if a, ok := jsAny(o["at"]).(string); ok {
		if d, ok := reminders.DateParse(a); ok {
			p.DueAt = &d
		}
	}
	if r, ok := o["repeat"]; ok && strings.TrimSpace(string(r)) == "null" {
		p.RepeatNull = true
	} else {
		p.Repeat = reminders.SanitizeRepeat(o["repeat"])
	}
	ch, err := s.Reminders.Update(tr.JSString(id), p)
	if err != nil {
		return nil
	}
	a := NewOMap()
	a.Set("id", ch.After.ID)
	s.userAudit("reminder_update", a, "ok")
	return &ch.After
}

func (s *Service) CancelReminder(id any) bool {
	ch, err := s.Reminders.Cancel(tr.JSString(id))
	if err != nil {
		return false
	}
	payload, _ := json.Marshal(ch.Before)
	s.Journal.Record("reminder_cancel", tr.T("electron.common.cancel-reminder", ch.Before.Text), []InverseOp{{Op: "custom", Kind: "reminder-restore", Payload: payload}})
	a := NewOMap()
	a.Set("id", ch.Before.ID)
	s.userAudit("reminder_cancel", a, "ok")
	return true
}

func (s *Service) SnoozeReminder(id, minutes any) bool {
	m := 10.0
	if f, ok := minutes.(float64); ok {
		m = f
	}
	if _, err := s.Reminders.Snooze(tr.JSString(id), m); err != nil {
		return false
	}
	a := NewOMap()
	a.Set("id", tr.JSString(id))
	s.userAudit("reminder_snooze", a, "ok")
	return true
}

func (s *Service) TakeMissedFor(surface string) []MissedItem {
	if !s.IsMascotSender(surface) {
		return []MissedItem{}
	}
	return s.TakeMissed()
}

func (s *Service) ReminderAction(surface string, id, action, minutes any) {
	sid, ok := id.(string)
	if !s.IsMascotSender(surface) || !ok {
		return
	}
	if action == "snooze" {
		m := 10.0
		if f, ok := minutes.(float64); ok {
			m = math.Min(1440, math.Max(1, f))
		}
		_, _ = s.Reminders.Snooze(sid, m)
	} else {
		_, _ = s.Reminders.Dismiss(sid)
	}
}

// AnswerConfirm：确认答复，来自对话窗口（契约按界面放行）或桌面角色窗口
func (s *Service) AnswerConfirm(surface string, id, allow, remember, pick any) {
	if surface != "chat" && !s.IsMascotSender(surface) {
		log.Printf("忽略来自非 Nomi 窗口的确认答复")
		return
	}
	if sid, ok := id.(string); ok && s.Broker.AnswerPick(sid, allow == true, remember == true, pick == true) {
		s.cancelConfirm(sid)
	}
	s.rehideMascotIfIdle()
}

func (s *Service) DropFile(surface string, p any) {
	sp, ok := p.(string)
	if !s.IsMascotSender(surface) || !ok || sp == "" {
		return
	}
	go s.SummarizeDropped(sp)
}

// jsAny 把一个 JSON 值解成 any（缺省 → nil）
func jsAny(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return v
}

// CreateService 对应 createDesktopService
func CreateService(userData string, ports Ports, emit Emitter) *Service {
	return NewService(filepath.Join(userData, "desktop"), ports, emit, []string{userData})
}

// Summarize = this.summarize（desktop.tools() 的 summarize 依赖；summary 角色模型）
func (s *Service) Summarize(text, instruction string) (string, error) {
	return s.summarize(text, instruction)
}

// ClipboardRead = ports.clipboard.readText()（没有端口按空剪贴板）
func (s *Service) ClipboardRead() (string, error) {
	if s.ports.ClipboardRead == nil {
		return "", nil
	}
	return s.ports.ClipboardRead()
}

// ClipboardWrite = ports.clipboard.writeText(t)
func (s *Service) ClipboardWrite(t string) error {
	if s.ports.ClipboardWrite == nil {
		return nil
	}
	return s.ports.ClipboardWrite(t)
}
