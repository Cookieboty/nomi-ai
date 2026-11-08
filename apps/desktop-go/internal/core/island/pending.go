package island

import (
	"errors"
	"slices"
	"strings"
)

// 等你处理的事（HITL）：编程助手要权限、沙箱拦下、持续任务等批准 / 验收、桌面操作确认……
// 由装配层（island_pending.go）汇总成一份列表推进来；岛上一直显示到处理完，每条带操作按钮，
// 点了经 Act 交给装配层的 resolver 真正处理（与对话里、任务页里的按钮走同一个接口）。

// Action：一条上的一个按钮
type Action struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Primary bool   `json:"primary,omitempty"`
	Danger  bool   `json:"danger,omitempty"`
}

// Pending：一条等你处理的事
type Pending struct {
	// ID：来源前缀 + 来源里的 id（perm:<标签>:<请求>、task:<任务>…），Act 原样带回
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title"`
	Body     string   `json:"body,omitempty"`
	Endpoint string   `json:"endpoint,omitempty"`
	Actions  []Action `json:"actions"`
	// At：开始等的时间（毫秒），先来的排前面
	At int64 `json:"at"`
}

// Labels：页面上的固定文案（{0} = 数量）
type Labels struct {
	Count string `json:"count"`
	More  string `json:"more"`
	Close string `json:"close"`
}

// ErrUnknownPending：要处理的那条已经不在了（别处处理过、过期）
var ErrUnknownPending = errors.New("ISLAND_PENDING_GONE")

// SetResolver：处理一条的函数（装配层按 id 前缀分给各来源）
func (s *Service) SetResolver(fn func(id, action string) error) {
	s.mu.Lock()
	s.resolver = fn
	s.mu.Unlock()
}

// SetOpener：打开某一条的函数（装配层：打开对话窗口并跳到它）
func (s *Service) SetOpener(fn func(id string)) {
	s.mu.Lock()
	s.opener = fn
	s.mu.Unlock()
}

// Pending：当前列表（关着「等你处理」时为空；用户关掉的也算在内，它们仍在等你）
func (s *Service) Pending() []Pending {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.all)
}

// Dismiss：用户按 Esc / 点关闭（nomi:island:dismiss）：现在列表里的先不显示，岛收起；有新的一条进来时再连同它们一起显示。
// 这些事没有被处理，对话里、任务页里照样能处理
func (s *Service) Dismiss() {
	s.mu.Lock()
	s.dismissed = map[string]bool{}
	for _, p := range s.all {
		s.dismissed[p.ID] = true
	}
	s.mu.Unlock()
	s.push()
}

// OpenItem：点了某一条（nomi:island:open:<id>）或它的「打开」：打开对话窗口并跳到它；不认识的只打开对话窗口
func (s *Service) OpenItem(id string) {
	s.mu.Lock()
	open := s.opener
	known := slices.ContainsFunc(s.all, func(p Pending) bool { return p.ID == id })
	s.mu.Unlock()
	if open != nil && known && !strings.HasPrefix(id, DebugPrefix) {
		open(id)
		return
	}
	s.Opened()
}

// SetPending：整份替换等你处理的事。关着灵动岛或「等你处理」时当作空列表（已经显示的会收起）。
// 先来的排前面；截断标题与说明。列表没变时不打扰页面。调试样例（DebugPending）总排在最后、不受开关影响。
func (s *Service) SetPending(list []Pending) {
	s.mu.Lock()
	s.raw = list
	s.mu.Unlock()
	s.push()
}

// DebugPending：开发版调试页的样例（整份替换；空 = 清掉）。点样例上的按钮只是把它拿掉
func (s *Service) DebugPending(list []Pending) {
	s.mu.Lock()
	s.debug = nil
	// 调试页主动放样例 = 要看：之前按 Esc 关掉的不再拦着（样例的 id 每次都一样）
	s.dismissed = nil
	for i, p := range list {
		if !strings.HasPrefix(p.ID, DebugPrefix) {
			p.ID = DebugPrefix + p.ID
		}
		if p.At == 0 {
			p.At = int64(i)
		}
		s.debug = append(s.debug, p)
	}
	s.mu.Unlock()
	s.push()
}

// DebugPrefix：调试样例的 id 前缀
const DebugPrefix = "debug\x1f"

func (s *Service) push() {
	s.mu.Lock()
	list := s.raw
	if !s.s.Enabled || !s.s.Kinds.Approval {
		list = nil
	}
	clean := make([]Pending, 0, len(list)+len(s.debug))
	for _, p := range list {
		p.Title, p.Body = sliceUTF16(p.Title, 80), sliceUTF16(p.Body, 160)
		if p.Endpoint != "" {
			p.Endpoint = sliceUTF16(p.Endpoint, 24)
		}
		clean = append(clean, p)
	}
	slices.SortStableFunc(clean, func(a, b Pending) int {
		switch {
		case a.At < b.At:
			return -1
		case a.At > b.At:
			return 1
		}
		return 0
	})
	clean = append(clean, s.debug...)
	s.all = clean
	// 用户关掉过：只剩关掉时就有的（或更少）就不显示；来了新的，连同关掉的一起显示
	shown := clean
	if len(clean) == 0 {
		// 都处理完了：关掉的记录作废
		s.dismissed = nil
	}
	if len(s.dismissed) > 0 {
		fresh := false
		for _, p := range clean {
			if !s.dismissed[p.ID] {
				fresh = true
				break
			}
		}
		if fresh {
			s.dismissed = nil
		} else {
			shown = nil
		}
	}
	same := samePending(s.pending, shown)
	wasEmpty := len(s.pending) == 0
	s.pending = shown
	clean = shown
	show, labels := s.host.ShowPending, s.host.Labels
	s.mu.Unlock()
	if same || show == nil || (wasEmpty && len(clean) == 0) {
		return
	}
	var l Labels
	if labels != nil {
		l = labels()
	}
	if err := show(clean, l); err != nil {
		s.warn("island pending failed", err)
	}
}

func samePending(a, b []Pending) bool {
	return slices.EqualFunc(a, b, func(x, y Pending) bool {
		return x.ID == y.ID && x.Title == y.Title && x.Body == y.Body && x.Endpoint == y.Endpoint &&
			slices.Equal(x.Actions, y.Actions)
	})
}

// Act：页面上点了一条的按钮（nomi:island:act）。处理失败（已经不在了等）时让页面恢复按钮
func (s *Service) Act(id, action string) error {
	s.mu.Lock()
	fn, failed := s.resolver, s.host.ActFailed
	known := slices.ContainsFunc(s.pending, func(p Pending) bool { return p.ID == id })
	s.mu.Unlock()
	err := ErrUnknownPending
	switch {
	case known && strings.HasPrefix(id, DebugPrefix):
		// 调试样例：点了就拿掉
		s.mu.Lock()
		s.debug = slices.DeleteFunc(s.debug, func(p Pending) bool { return p.ID == id })
		s.mu.Unlock()
		s.push()
		return nil
	case known && fn != nil:
		err = fn(id, action)
	}
	if err != nil && failed != nil {
		failed(id)
	}
	return err
}

// Resized：页面报来岛的高度（nomi:island:size）→ 窗口跟着改
func (s *Service) Resized(h float64) {
	s.mu.Lock()
	resize := s.host.Resize
	s.mu.Unlock()
	g, ok := s.Layout()
	if resize == nil || !ok {
		return
	}
	resize(IslandWindowRect(g, ContentHeight(g, h)))
}

func (s *Service) warn(msg string, err error) {
	s.mu.Lock()
	w := s.host.Warn
	s.mu.Unlock()
	if w != nil {
		w(msg, err)
	}
}
