// Package tabwindows：对话旁标签区的标签弹到独立窗口（chatWindow.detachTab / detachedTabs / dockTab，
// 见 docs/design/side-tabs-workspace.md）。
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
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

const (
	// EventChanged：开着的弹出窗口 id 列表变了（整份）
	EventChanged = "chatWindow.detachedChanged"
	// EventDocked：弹出窗口里点了「放回主窗口」
	EventDocked = "chatWindow.tabDocked"
	// QueryKey：新窗口地址里带 spec 的查询参数（视图 utils/detachedTabs.ts 读同一个名字）
	QueryKey = "detached"

	maxID    = 2048
	maxSpec  = 16384
	maxTitle = 200
	// maxWindows：同时开着的弹出窗口上限（每个都是一个 WebView，防止误操作开出一堆）
	maxWindows = 12
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

// Manager 记着开着的弹出窗口
type Manager struct {
	mu     sync.Mutex
	open   map[string]bool
	opener func() Opener
	emit   func(event string, data any)
}

// New：opener 用函数取（外壳在契约注册之后才建）；返回 nil 时 detachTab 报 UNAVAILABLE。emit 推给 chat 面
func New(opener func() Opener, emit func(event string, data any)) *Manager {
	return &Manager{open: map[string]bool{}, opener: opener, emit: emit}
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

func (m *Manager) closed(id string) {
	m.mu.Lock()
	had := m.open[id]
	delete(m.open, id)
	m.mu.Unlock()
	if had {
		m.changed()
	}
}

// Dock：「放回主窗口」——先通知主窗口切到这个标签，再关窗口（关窗口后 detachedChanged 让标签回到标签栏）
func (m *Manager) Dock(id string) bool {
	m.mu.Lock()
	ok := m.open[id]
	m.mu.Unlock()
	if !ok {
		return false
	}
	if m.emit != nil {
		m.emit(EventDocked, map[string]any{"id": id})
	}
	if op := m.opener(); op != nil {
		op.CloseDetached(id)
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

// Register 注册 chatWindow.* 三个过程
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
	r.Call("chatWindow.dockTab", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err.Error())
		}
		return m.Dock(in.ID), nil
	})
}
