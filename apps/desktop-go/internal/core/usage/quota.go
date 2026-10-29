package usage

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 对应 quota.ts：订阅额度（尽力而为）。
// 原则：只用本机已经有的数据，或让官方 CLI 自己读取登录态后返回的额度结果；不读取凭据文件，
// 不把原始 billing 响应写入磁盘或日志。新来源通过 QuotaRegistry.Register 接入。
//
// 可选字段用指针 / 零值省略；结构体字段顺序 = Node 对象字面量的键顺序（JSON 序列化逐键一致）。

// QuotaWindow = interface QuotaWindow（一个额度窗口）。
type QuotaWindow struct {
	ID string `json:"id"`
	// 已用百分比 0–100（NaN = 非 number，sanitize 时丢弃）
	UsedPercent   float64  `json:"usedPercent"`
	WindowMinutes *float64 `json:"windowMinutes,omitempty"`
	ResetAt       *float64 `json:"resetAt,omitempty"`
	Expired       *bool    `json:"expired,omitempty"`
}

// QuotaOrigin = 'statusline' | 'usage-cmd' | 'session-log' | 'app-server' | 'grok-acp'
type QuotaOrigin = string

// QuotaReading = interface QuotaReading。键顺序：windows, updatedAt, origin, plan, stale
// （与 claudeSubscription / codexRateLimits / grokSubscription 的字面量及 quotaCache.get 的 stale 追加一致）。
type QuotaReading struct {
	Windows   []QuotaWindow `json:"windows"`
	UpdatedAt float64       `json:"updatedAt"`
	Origin    QuotaOrigin   `json:"origin,omitempty"`
	Plan      string        `json:"plan,omitempty"`
	Stale     bool          `json:"stale,omitempty"`
}

// Clone = { ...reading }（浅拷贝：windows 数组共享，同 JS）。
func (r *QuotaReading) Clone() *QuotaReading {
	if r == nil {
		return nil
	}
	c := *r
	return &c
}

// QuotaEntry = interface QuotaEntry。auth 由 authMode.applyAuthModes 以 `{ ...e, auth }` 追加在末尾。
type QuotaEntry struct {
	ID        string        `json:"id"`
	Label     string        `json:"label"`
	Status    string        `json:"status"` // 'ok' | 'unavailable' | 'api'
	Windows   []QuotaWindow `json:"windows"`
	UpdatedAt *float64      `json:"updatedAt,omitempty"`
	Plan      string        `json:"plan,omitempty"`
	Origin    QuotaOrigin   `json:"origin,omitempty"`
	Stale     bool          `json:"stale,omitempty"`
	Auth      string        `json:"auth,omitempty"` // 'subscription' | 'api' | 'unknown'
}

// QuotaSource：Read 必须是同步、无网络、无凭据读取的；返回 nil = 没有可用额度。Read 里 panic = 抛错。
type QuotaSource struct {
	ID    string
	Label string
	Read  func(now float64) *QuotaReading
}

// QuotaPlaceholder = placeholders 的元素 { id, label }。
type QuotaPlaceholder struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// QuotaRegistry = class QuotaRegistry（Map 语义：重复 register 覆盖值但保留原插入位置；delete 后再 set 排到末尾）。
type QuotaRegistry struct {
	order   []string
	sources map[string]QuotaSource
}

func NewQuotaRegistry() *QuotaRegistry {
	return &QuotaRegistry{sources: map[string]QuotaSource{}}
}

func (q *QuotaRegistry) Register(s QuotaSource) {
	if q.sources == nil {
		q.sources = map[string]QuotaSource{}
	}
	if _, ok := q.sources[s.ID]; !ok {
		q.order = append(q.order, s.ID)
	}
	q.sources[s.ID] = s
}

func (q *QuotaRegistry) Unregister(id string) {
	if _, ok := q.sources[id]; !ok {
		return
	}
	delete(q.sources, id)
	for i, k := range q.order {
		if k == id {
			q.order = append(q.order[:i:i], q.order[i+1:]...)
			break
		}
	}
}

// Collect：已注册来源按注册顺序；placeholders 里没有数据的工具补一行「不可用」。来源抛错 / 不合法数据都按「不可用」。
func (q *QuotaRegistry) Collect(now float64, placeholders []QuotaPlaceholder) []QuotaEntry {
	out := []QuotaEntry{}
	seen := map[string]bool{}
	for _, id := range q.order {
		s := q.sources[id]
		r := safeRead(s, now)
		windows := []QuotaWindow{}
		if r != nil {
			windows = SanitizeWindows(r.Windows, now)
		}
		seen[s.ID] = true
		if r != nil && len(windows) > 0 {
			u := r.UpdatedAt
			out = append(out, QuotaEntry{ID: s.ID, Label: s.Label, Status: "ok", Windows: windows, UpdatedAt: &u,
				Plan: r.Plan, Origin: r.Origin, Stale: r.Stale})
		} else {
			out = append(out, QuotaEntry{ID: s.ID, Label: s.Label, Status: "unavailable", Windows: []QuotaWindow{}})
		}
	}
	for _, p := range placeholders {
		if !seen[p.ID] {
			out = append(out, QuotaEntry{ID: p.ID, Label: p.Label, Status: "unavailable", Windows: []QuotaWindow{}})
		}
	}
	return out
}

func safeRead(s QuotaSource, now float64) (r *QuotaReading) {
	defer func() {
		if recover() != nil {
			r = nil
		}
	}()
	return s.Read(now)
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// SanitizeWindows = sanitizeWindows：去掉不合法的窗口；超过重置时间的标 expired。
func SanitizeWindows(ws []QuotaWindow, now float64) []QuotaWindow {
	out := []QuotaWindow{}
	for _, w := range ws {
		if !finite(w.UsedPercent) {
			continue
		}
		if w.UsedPercent < 0 {
			continue
		}
		var resetAt *float64
		if w.ResetAt != nil && finite(*w.ResetAt) && *w.ResetAt > 0 {
			v := *w.ResetAt
			resetAt = &v
		}
		var minutes *float64
		if w.WindowMinutes != nil && *w.WindowMinutes > 0 {
			v := *w.WindowMinutes
			minutes = &v
		}
		nw := QuotaWindow{ID: w.ID, UsedPercent: math.Min(100, w.UsedPercent), WindowMinutes: minutes, ResetAt: resetAt}
		if resetAt != nil && *resetAt <= now {
			t := true
			nw.Expired = &t
		}
		out = append(out, nw)
	}
	return out
}

// ToObj：Node 对象形状（键顺序同字面量；-0 / Infinity 走 JSON.stringify 语义）。
func (w QuotaWindow) ToObj() *util.Obj {
	o := util.NewObj("id", w.ID, "usedPercent", w.UsedPercent)
	if w.WindowMinutes != nil {
		o.Set("windowMinutes", *w.WindowMinutes)
	}
	if w.ResetAt != nil {
		o.Set("resetAt", *w.ResetAt)
	}
	if w.Expired != nil {
		o.Set("expired", *w.Expired)
	}
	return o
}

func windowsAny(ws []QuotaWindow) []any {
	out := make([]any, len(ws))
	for i, w := range ws {
		out[i] = w.ToObj()
	}
	return out
}

func (r QuotaReading) ToObj() *util.Obj {
	o := util.NewObj("windows", windowsAny(r.Windows), "updatedAt", r.UpdatedAt)
	if r.Origin != "" {
		o.Set("origin", r.Origin)
	}
	if r.Plan != "" {
		o.Set("plan", r.Plan)
	}
	if r.Stale {
		o.Set("stale", true)
	}
	return o
}

func (e QuotaEntry) ToObj() *util.Obj {
	o := util.NewObj("id", e.ID, "label", e.Label, "status", e.Status, "windows", windowsAny(e.Windows))
	if e.UpdatedAt != nil {
		o.Set("updatedAt", *e.UpdatedAt)
	}
	if e.Plan != "" {
		o.Set("plan", e.Plan)
	}
	if e.Origin != "" {
		o.Set("origin", e.Origin)
	}
	if e.Stale {
		o.Set("stale", true)
	}
	if e.Auth != "" {
		o.Set("auth", e.Auth)
	}
	return o
}

func (w QuotaWindow) MarshalJSON() ([]byte, error)  { return []byte(util.Stringify(w.ToObj())), nil }
func (r QuotaReading) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(r.ToObj())), nil }
func (e QuotaEntry) MarshalJSON() ([]byte, error)   { return []byte(util.Stringify(e.ToObj())), nil }
