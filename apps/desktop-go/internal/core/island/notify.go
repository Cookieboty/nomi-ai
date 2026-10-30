package island

import (
	"unicode/utf16"
)

// Notice = IslandNotice（core/desktop/islandNotice.ts）
type Notice struct {
	Kind       string `json:"kind"` // message | agent | reminder | info
	Title      string `json:"title"`
	Body       string `json:"body"`
	DurationMs *int   `json:"durationMs,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	Status     string `json:"status,omitempty"` // done | failed | attention | running
}

// Host：岛窗口的宿主能力（= IslandService 里的 BrowserWindow 操作）
type Host struct {
	// Present 确保岛窗口在（几何变了就重建）、填入通知并播放展开（= ensureWindow + prepare / showInactive / play）
	Present func(n Notice) error
	// Hide 收起后隐藏窗口（页面 'hidden:' 信号）
	Hide func()
	// Destroy 关掉开关时释放窗口
	Destroy func()
	// OpenChat 点击岛（页面 '#open-' 信号）
	OpenChat func()
	// IsQuiet 免打扰时段（日程 → 免打扰）
	IsQuiet func() bool
	// Warn 记录失败
	Warn func(msg string, err error)
}

// SetHost 注入岛窗口能力；未注入时通知一律不显示
func (s *Service) SetHost(h Host) {
	s.mu.Lock()
	s.host = h
	s.mu.Unlock()
}

// Accepts = accepts(n, force)：是否会显示这条通知（开关 / 类型 / 免打扰）
func (s *Service) Accepts(n Notice, force bool) bool {
	if force {
		return true
	}
	s.mu.Lock()
	st, quiet := s.s, s.host.IsQuiet
	s.mu.Unlock()
	if !st.Enabled {
		return false
	}
	switch n.Kind {
	case "message":
		if !st.Kinds.Message {
			return false
		}
	case "agent":
		if !st.Kinds.Agent {
			return false
		}
	case "reminder":
		if !st.Kinds.Reminder {
			return false
		}
	}
	return quiet == nil || !quiet()
}

// sliceUTF16 = String.prototype.slice(0, n)（按 UTF-16 码元截断，与 Node 一致）
func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

// Notify = notify(n, force)：过滤、截断、排队去重（最多 5 条）后逐条显示；返回是否接受
func (s *Service) Notify(n Notice, force bool) bool {
	if !s.Accepts(n, force) {
		return false
	}
	clean := Notice{
		Kind:       n.Kind,
		Title:      sliceUTF16(n.Title, 80),
		Body:       sliceUTF16(n.Body, 160),
		DurationMs: n.DurationMs,
		Status:     n.Status,
	}
	if n.Endpoint != "" {
		clean.Endpoint = sliceUTF16(n.Endpoint, 24)
	}
	s.mu.Lock()
	dup := false
	for _, q := range s.queue {
		if q.Title == clean.Title && q.Body == clean.Body {
			dup = true
			break
		}
	}
	if !dup {
		s.queue = append(s.queue, clean)
	}
	if len(s.queue) > 5 {
		s.queue = s.queue[len(s.queue)-5:]
	}
	s.mu.Unlock()
	go s.pump()
	return true
}

// pump：一次只显示一条；展开失败时停在这里（与 Node 相同，下一条通知进来再试）
func (s *Service) pump() {
	s.mu.Lock()
	if s.showing || len(s.queue) == 0 || s.host.Present == nil {
		s.mu.Unlock()
		return
	}
	next := s.queue[0]
	s.queue = s.queue[1:]
	s.showing = true
	present, warn := s.host.Present, s.host.Warn
	s.mu.Unlock()
	if err := present(next); err != nil {
		s.mu.Lock()
		s.showing = false
		s.mu.Unlock()
		if warn != nil {
			warn("island notify failed", err)
		}
	}
}

// Hidden：页面收起动画结束（document.title = 'hidden:…'）→ 隐藏窗口、显示下一条
func (s *Service) Hidden() {
	s.mu.Lock()
	hide := s.host.Hide
	s.showing = false
	s.mu.Unlock()
	if hide != nil {
		hide()
	}
	go s.pump()
}

// Opened：点击岛（location.hash = '#open-…'）→ 打开对话窗口
func (s *Service) Opened() {
	s.mu.Lock()
	open := s.host.OpenChat
	s.mu.Unlock()
	if open != nil {
		open()
	}
}

// destroyWindow = destroy()：释放窗口，正在显示的那条作废
func (s *Service) destroyWindow() {
	s.mu.Lock()
	destroy := s.host.Destroy
	s.showing = false
	s.mu.Unlock()
	if destroy != nil {
		destroy()
	}
}

// Test = test()：设置页「测试」，不论开关与免打扰都弹一条示例通知；返回是否显示
func (s *Service) Test(title, body string) bool {
	d := 4000
	return s.Notify(Notice{Kind: "message", Title: title, Body: body, DurationMs: &d}, true)
}
