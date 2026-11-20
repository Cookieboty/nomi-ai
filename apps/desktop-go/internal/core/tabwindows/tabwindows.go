// Package tabwindows：对话旁标签区的标签弹到独立窗口（chatWindow.detachTab / detachedTabs / dockTab，
// 见 docs/design/side-tabs-workspace.md）。只在界面内存里的标签（侧边聊天）弹出 / 放回时，
// 内容经 chatWindow.handoffPut / handoffTake 在宿主内存里交接（不落盘）。
//
// 这里只管「哪些标签开着独立窗口」与事件；原生窗口由外壳（wailsshell.OpenDetached）建。
// 新窗口加载同一个对话页面（/chat/index.html?detached=<spec>），拿自己的 chat 面 token，
// 页面按 spec 只画那一个子任务 / 文件，所以流式输出、输入栏、授权回复和主窗口里一样（都按会话 / 标签 id 绑定）。
package tabwindows

import (
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

const (
	// EventChanged：开着的弹出窗口 id 列表变了（整份）
	EventChanged = "chatWindow.detachedChanged"
	// EventDocked：弹出窗口里点了「放回主窗口」
	EventDocked = "chatWindow.tabDocked"
	// EventDockRequest：请求主窗口接收放回标签并在完成后返回 dockAck
	EventDockRequest = "chatWindow.dockRequest"
	// QueryKey：新窗口地址里带 spec 的查询参数（视图 utils/detachedTabs.ts 读同一个名字）
	QueryKey = "detached"

	maxID         = 2048
	maxSpec       = 16384
	maxTitle      = 200
	maxTransferID = 256
	// defaultAckTimeout：等待主窗口确认收下放回标签与快照的超时
	defaultAckTimeout = 5 * time.Second
	// maxWindows：同时开着的弹出窗口上限（每个都是一个 WebView，防止误操作开出一堆）
	maxWindows = 12
	// 交接快照（侧边聊天这类只在界面内存里的标签）：单份上限与总份数上限（超过时丢最早放进来的）
	maxHandoff      = 8 << 20
	maxHandoffCount = 24
)

// Opener 是外壳提供的原生窗口操作（wailsshell 实现；测试里用假的）
type Opener interface {
	// OpenDetached 新建窗口：页面查询串是 query，标题 title；窗口被关掉（用户关、Close、退出）时调 onClosed 一次
	OpenDetached(id, title, query string, onClosed func()) error
	// FocusDetached 把已开着的窗口提到最前（最小化的先还原）
	FocusDetached(id string)
	// CloseDetached 关掉窗口（会触发 onClosed）
	CloseDetached(id string)
}

type handoffKey struct {
	id  string
	dir string
}

type handoffEntry struct {
	data           string
	transferID     string
	targetCallerID int
	keepUntilAck   bool
}

type dockWait struct {
	transferID string
	ch         chan bool
}

// Manager 记着开着的弹出窗口
type Manager struct {
	mu           sync.Mutex
	open         map[string]bool
	opener       func() Opener
	emit         func(event string, data any)
	emitCaller   func(callerID int, event string, data any) bool
	ackTimeout   time.Duration
	hostCallerID int
	pendingDocks map[string]*dockWait
	// handoff：等另一个窗口取走的快照（只在内存里）；order 是放进来的先后
	handoff map[handoffKey]handoffEntry
	order   []handoffKey
}

// New：opener 用函数取（外壳在契约注册之后才建）；返回 nil 时 detachTab 报 UNAVAILABLE。emit 推给 chat 面
func New(opener func() Opener, emit func(event string, data any)) *Manager {
	return &Manager{
		open:         map[string]bool{},
		opener:       opener,
		emit:         emit,
		ackTimeout:   defaultAckTimeout,
		pendingDocks: map[string]*dockWait{},
		handoff:      map[handoffKey]handoffEntry{},
	}
}

// SetCallerEmitter 设置按连接 callerID 定向推事件的函数（router.EmitToCaller）
func (m *Manager) SetCallerEmitter(fn func(callerID int, event string, data any) bool) {
	m.mu.Lock()
	m.emitCaller = fn
	m.mu.Unlock()
}

// SetAckTimeout 设置放回 ACK 超时时长（测试可缩短；<=0 忽略）
func (m *Manager) SetAckTimeout(d time.Duration) {
	if d <= 0 {
		return
	}
	m.mu.Lock()
	m.ackTimeout = d
	m.mu.Unlock()
}

// DetachInput = 契约 DetachTabInput
type DetachInput struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Spec  string `json:"spec"`
}

// DetachResult = 契约 DetachTabResult
type DetachResult struct {
	OK      bool `json:"ok"`
	Focused bool `json:"focused"`
}

func bad(msg string) error { return &contract.Error{Code: "BAD_INPUT", Message: msg} }

// Title：窗口标题（去掉控制字符、截断；空时用产品名）
func Title(title, product string) string {
	title = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(title))
	if utf8.RuneCountInString(title) > 80 {
		title = string([]rune(title)[:80]) + "…"
	}
	if title == "" {
		return product
	}
	return title + " — " + product
}

// Detach 弹出（同一个 id 已开着时提到最前）
func (m *Manager) Detach(in DetachInput) (DetachResult, error) {
	if in.ID == "" || len(in.ID) > maxID {
		return DetachResult{}, bad("id")
	}
	if len(in.Title) > maxTitle*4 {
		return DetachResult{}, bad("title")
	}
	if len(in.Spec) > maxSpec {
		return DetachResult{}, bad("spec too long")
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal([]byte(in.Spec), &probe); err != nil {
		return DetachResult{}, bad("spec must be a JSON object")
	}
	op := m.opener()
	if op == nil {
		return DetachResult{}, &contract.Error{Code: "UNAVAILABLE", Message: "no window shell"}
	}
	m.mu.Lock()
	if m.open[in.ID] {
		m.mu.Unlock()
		op.FocusDetached(in.ID)
		return DetachResult{OK: true, Focused: true}, nil
	}
	if len(m.open) >= maxWindows {
		m.mu.Unlock()
		return DetachResult{}, &contract.Error{Code: "UNAVAILABLE", Message: "too many detached windows"}
	}
	m.open[in.ID] = true
	m.mu.Unlock()
	q := url.Values{}
	q.Set(QueryKey, in.Spec)
	id := in.ID
	var once sync.Once
	if err := op.OpenDetached(id, in.Title, q.Encode(), func() { once.Do(func() { m.closed(id) }) }); err != nil {
		m.mu.Lock()
		delete(m.open, id)
		m.mu.Unlock()
		return DetachResult{}, &contract.Error{Code: "UNAVAILABLE", Message: err.Error()}
	}
	m.changed()
	return DetachResult{OK: true}, nil
}

// HandoffPutInput = 契约 HandoffPutInput
type HandoffPutInput struct {
	ID           string `json:"id"`
	Data         string `json:"data"`
	TransferID   string `json:"transferId,omitempty"`
	Direction    string `json:"direction,omitempty"`
	KeepUntilAck bool   `json:"keepUntilAck,omitempty"`
}

// HandoffTakeInput = 契约 HandoffTakeInput
type HandoffTakeInput struct {
	ID         string `json:"id"`
	TransferID string `json:"transferId,omitempty"`
	Direction  string `json:"direction,omitempty"`
}

// DockInput = 契约 DockTabInput
type DockInput struct {
	ID         string `json:"id"`
	TransferID string `json:"transferId,omitempty"`
	RequireAck bool   `json:"requireAck,omitempty"`
}

// DockAckInput = 契约 DockAckInput
type DockAckInput struct {
	ID         string `json:"id"`
	TransferID string `json:"transferId"`
	OK         bool   `json:"ok"`
}

func (m *Manager) closed(id string) {
	m.mu.Lock()
	had := m.open[id]
	delete(m.open, id)
	if w := m.pendingDocks[id]; w != nil {
		delete(m.pendingDocks, id)
		select {
		case w.ch <- false:
		default:
		}
	}
	m.mu.Unlock()
	if had {
		m.changed()
	}
}

// RegisterHost 把当前调用方登记为主窗口接收者（排他；连接关闭时自动清理）。
func (m *Manager) RegisterHost(caller contract.Caller) bool {
	if caller.ID <= 0 {
		return false
	}
	m.mu.Lock()
	if m.hostCallerID != 0 && m.hostCallerID != caller.ID {
		for id, w := range m.pendingDocks {
			select {
			case w.ch <- false:
			default:
			}
			delete(m.pendingDocks, id)
		}
	}
	m.hostCallerID = caller.ID
	m.mu.Unlock()
	if caller.Done != nil {
		go func(id int, done <-chan struct{}) {
			<-done
			m.mu.Lock()
			if m.hostCallerID == id {
				m.hostCallerID = 0
				for k, w := range m.pendingDocks {
					select {
					case w.ch <- false:
					default:
					}
					delete(m.pendingDocks, k)
				}
			}
			m.mu.Unlock()
		}(caller.ID, caller.Done)
	}
	return true
}

func (m *Manager) clearKeepUntilAckLocked(id, transferID string) {
	key := handoffKey{id: id, dir: "dock"}
	entry, ok := m.handoff[key]
	if !ok || !entry.keepUntilAck || entry.transferID != transferID {
		return
	}
	entry.keepUntilAck = false
	entry.transferID = ""
	m.handoff[key] = entry
}

// Dock：「放回主窗口」——旧版无 ACK 模式：先通知主窗口切到这个标签，再关窗口
func (m *Manager) Dock(id string) bool {
	m.mu.Lock()
	ok := m.open[id]
	emit := m.emit
	m.mu.Unlock()
	if !ok {
		return false
	}
	if emit != nil {
		emit(EventDocked, map[string]any{"id": id})
	}
	if op := m.opener(); op != nil {
		op.CloseDetached(id)
	}
	return true
}

// DockWithOptions 放回主窗口：当 RequireAck 为真时采用两阶段确认，主窗口确认收下后才删临时快照并关窗。
func (m *Manager) DockWithOptions(ctx context.Context, _ contract.Caller, in DockInput) bool {
	if !in.RequireAck {
		return m.Dock(in.ID)
	}
	if in.ID == "" || len(in.ID) > maxID || in.TransferID == "" || len(in.TransferID) > maxTransferID {
		return false
	}
	m.mu.Lock()
	if !m.open[in.ID] || m.hostCallerID <= 0 || m.emitCaller == nil || m.pendingDocks[in.ID] != nil {
		m.mu.Unlock()
		return false
	}
	wait := &dockWait{transferID: in.TransferID, ch: make(chan bool, 1)}
	m.pendingDocks[in.ID] = wait
	hostID := m.hostCallerID
	emitCaller := m.emitCaller
	timeout := m.ackTimeout
	if timeout <= 0 {
		timeout = defaultAckTimeout
	}
	m.mu.Unlock()

	if !emitCaller(hostID, EventDockRequest, map[string]any{
		"id":         in.ID,
		"transferId": in.TransferID,
	}) {
		m.mu.Lock()
		if m.pendingDocks[in.ID] == wait {
			delete(m.pendingDocks, in.ID)
		}
		m.clearKeepUntilAckLocked(in.ID, in.TransferID)
		m.mu.Unlock()
		return false
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	ackOK := false
	select {
	case ackOK = <-wait.ch:
	case <-timer.C:
		ackOK = false
	case <-ctx.Done():
		ackOK = false
	}

	m.mu.Lock()
	if m.pendingDocks[in.ID] == wait {
		delete(m.pendingDocks, in.ID)
	}
	if !ackOK {
		m.clearKeepUntilAckLocked(in.ID, in.TransferID)
		m.mu.Unlock()
		return false
	}
	key := handoffKey{id: in.ID, dir: "dock"}
	if entry, ok := m.handoff[key]; ok && entry.transferID == in.TransferID {
		delete(m.handoff, key)
		m.dropOrder(key)
	}
	stillOpen := m.open[in.ID]
	emit := m.emit
	m.mu.Unlock()
	if !stillOpen {
		return false
	}
	if emit != nil {
		emit(EventDocked, map[string]any{"id": in.ID})
	}
	if op := m.opener(); op != nil {
		op.CloseDetached(in.ID)
	}
	return true
}

// DockAck 主窗口完成放回接收后发送确认，唤醒阻塞等待的 DockWithOptions。
func (m *Manager) DockAck(caller contract.Caller, in DockAckInput) bool {
	if caller.ID <= 0 || in.ID == "" || len(in.ID) > maxID || in.TransferID == "" || len(in.TransferID) > maxTransferID {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.hostCallerID != caller.ID {
		return false
	}
	wait := m.pendingDocks[in.ID]
	if wait == nil || wait.transferID != in.TransferID {
		return false
	}
	delete(m.pendingDocks, in.ID)
	select {
	case wait.ch <- in.OK:
	default:
	}
	return true
}

// List 开着的弹出窗口 id（排好序）
func (m *Manager) List() []string {
	m.mu.Lock()
	out := make([]string, 0, len(m.open))
	for id := range m.open {
		out = append(out, id)
	}
	m.mu.Unlock()
	sort.Strings(out)
	return out
}

func (m *Manager) changed() {
	if m.emit != nil {
		m.emit(EventChanged, m.List())
	}
}

// Put：放一份交接快照（同一个 id 覆盖旧的）；不解析内容，只查是 JSON
func (m *Manager) Put(id, data string) error {
	return m.PutWithOptions(contract.Caller{}, HandoffPutInput{ID: id, Data: data})
}

// PutWithOptions 放一份按方向隔离的交接快照（dock 方向自动绑定当前 hostCallerID）。
func (m *Manager) PutWithOptions(_ contract.Caller, in HandoffPutInput) error {
	if in.ID == "" || len(in.ID) > maxID {
		return bad("id")
	}
	if len(in.TransferID) > maxTransferID {
		return bad("transferId")
	}
	if in.Direction != "" && in.Direction != "detach" && in.Direction != "dock" {
		return bad("direction")
	}
	if len(in.Data) > maxHandoff {
		return bad("data too long")
	}
	if !json.Valid([]byte(in.Data)) {
		return bad("data must be JSON")
	}
	key := handoffKey{id: in.ID, dir: in.Direction}
	m.mu.Lock()
	defer m.mu.Unlock()
	targetCallerID := 0
	if in.Direction == "dock" {
		targetCallerID = m.hostCallerID
	}
	if _, ok := m.handoff[key]; ok {
		m.dropOrder(key)
	}
	m.handoff[key] = handoffEntry{
		data:           in.Data,
		transferID:     in.TransferID,
		targetCallerID: targetCallerID,
		keepUntilAck:   in.KeepUntilAck,
	}
	m.order = append(m.order, key)
	for len(m.order) > maxHandoffCount {
		delete(m.handoff, m.order[0])
		m.order = m.order[1:]
	}
	return nil
}

// Take：取走一份快照（取一次就删）；没有时 ok = false
func (m *Manager) Take(id string) (string, bool) {
	return m.TakeWithOptions(contract.Caller{}, HandoffTakeInput{ID: id})
}

func (m *Manager) lookupHandoffLocked(id, dir string) (handoffKey, handoffEntry, bool) {
	if dir != "" {
		k := handoffKey{id: id, dir: dir}
		e, ok := m.handoff[k]
		return k, e, ok
	}
	for _, candidate := range []string{"", "dock", "detach"} {
		k := handoffKey{id: id, dir: candidate}
		if e, ok := m.handoff[k]; ok {
			return k, e, true
		}
	}
	return handoffKey{}, handoffEntry{}, false
}

func (m *Manager) canTakeDockLocked(caller contract.Caller, entry handoffEntry) bool {
	if entry.keepUntilAck {
		return entry.targetCallerID > 0 && caller.ID == entry.targetCallerID
	}
	if m.hostCallerID > 0 {
		return caller.ID == m.hostCallerID
	}
	if entry.targetCallerID > 0 {
		return caller.ID == entry.targetCallerID
	}
	return true
}

// TakeWithOptions 按方向、transferId 与接收者权限取走或读取交接快照（keepUntilAck 时只读不删）。
func (m *Manager) TakeWithOptions(caller contract.Caller, in HandoffTakeInput) (string, bool) {
	if in.ID == "" || len(in.ID) > maxID {
		return "", false
	}
	if in.Direction != "" && in.Direction != "detach" && in.Direction != "dock" {
		return "", false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key, entry, ok := m.lookupHandoffLocked(in.ID, in.Direction)
	if !ok {
		return "", false
	}
	if key.dir == "dock" && !m.canTakeDockLocked(caller, entry) {
		return "", false
	}
	if in.TransferID != "" && entry.transferID != in.TransferID {
		return "", false
	}
	if entry.keepUntilAck && entry.transferID != "" && in.TransferID != entry.transferID {
		return "", false
	}
	if !entry.keepUntilAck {
		delete(m.handoff, key)
		m.dropOrder(key)
	}
	return entry.data, true
}

func (m *Manager) dropOrder(key handoffKey) {
	for i, x := range m.order {
		if x == key {
			m.order = append(m.order[:i], m.order[i+1:]...)
			return
		}
	}
}

// Register 注册 chatWindow.* 过程
func Register(r *contract.Router, m *Manager) {
	r.Call("chatWindow.detachTab", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in DetachInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err.Error())
		}
		return m.Detach(in)
	})
	r.Call("chatWindow.detachedTabs", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return m.List(), nil
	})
	r.Call("chatWindow.registerHost", func(_ context.Context, caller contract.Caller, _ json.RawMessage) (any, error) {
		return m.RegisterHost(caller), nil
	})
	r.Call("chatWindow.dockTab", func(ctx context.Context, caller contract.Caller, raw json.RawMessage) (any, error) {
		var in DockInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err.Error())
		}
		return m.DockWithOptions(ctx, caller, in), nil
	})
	r.Call("chatWindow.dockAck", func(_ context.Context, caller contract.Caller, raw json.RawMessage) (any, error) {
		var in DockAckInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err.Error())
		}
		return m.DockAck(caller, in), nil
	})
	r.Call("chatWindow.handoffPut", func(_ context.Context, caller contract.Caller, raw json.RawMessage) (any, error) {
		var in HandoffPutInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err.Error())
		}
		if err := m.PutWithOptions(caller, in); err != nil {
			return nil, err
		}
		return true, nil
	})
	r.Call("chatWindow.handoffTake", func(_ context.Context, caller contract.Caller, raw json.RawMessage) (any, error) {
		var in HandoffTakeInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err.Error())
		}
		if data, ok := m.TakeWithOptions(caller, in); ok {
			return data, nil
		}
		return nil, nil
	})
}
