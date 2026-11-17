// Package browserwindow：对话旁标签区「浏览器」标签的原生窗口（见 docs/design/side-tabs-workspace.md）。
//
// 网页不放在 iframe 里：子框架会被目标站点的 `X-Frame-Options` / `CSP frame-ancestors` 拒掉
// （Google、GitHub 这类都拒嵌），而且浏览器保留随时拒绝的权利，应用侧只能显示一张
// 「已阻止此内容」的错误页。这里改成宿主开一个独立原生窗口、贴着视图给的区域显示：
// 网页是顶层文档，不参与这些判定，自签证书也走正常的警告页而不是被静默拦掉。
//
// 本包只管「哪个标签开着、开着哪个地址、贴在哪儿」，真正的窗口在 wailsshell（实现 shell.BrowserHost）。
package browserwindow

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

const (
	maxID  = 512
	maxURL = 8192
	// maxWindows：同时开着的浏览器窗口上限（每个都是独立 WebView，防止误操作开出一堆）。
	// 标签切走只是藏起来、窗口还在，所以同一个会话段里多开几个标签、多切几次会话都可能碰到这个上限；
	// 8 足够覆盖正常用法，同时还能拦住「一個坏掉的循环开出几百个」。
	maxWindows = 8
)

// Region = 契约 BrowserRegion（视图 CSS px，相对对话窗口内容区左上角）
type Region struct {
	X      int
	Y      int
	Width  int
	Height int
}

// ShowResult = 契约 BrowserWindowShowResult
type ShowResult struct {
	OK      bool    `json:"ok"`
	Reason  *string `json:"reason,omitempty"`
	Message *string `json:"message,omitempty"`
}

// Manager 记着开着的浏览器窗口：id 由视图定（会话 + 标签键），同一个 id 复用同一个原生窗口
type Manager struct {
	mu     sync.Mutex
	open   map[string]*state
	opener func() shell.BrowserHost
	emit   func(event string, data any)

	// watched：已经挂过「连接断开就收窗口」的连接 id（每个连接只挂一次）
	watchMu sync.Mutex
	watched map[int]bool
}

type state struct {
	url     string
	region  Region
	visible bool
	// owner：开这个窗口的连接（contract.Caller.ID）。连接断开时把它名下的窗口全收掉，
	// 免得视图重载 / 热更新留下的原生视图没人认领。0 = 不限（测试与内部调用）。
	owner int
}

// New：opener 用函数取（外壳在契约注册之后才建），返回 nil 时 show 报 unsupported；emit 推给 chat 面
func New(opener func() shell.BrowserHost, emit func(event string, data any)) *Manager {
	return &Manager{open: map[string]*state{}, opener: opener, emit: emit, watched: map[int]bool{}}
}

func bad(msg string) error { return &contract.Error{Code: "BAD_INPUT", Message: msg} }

// normalizeURL：只放行 http(s) 绝对地址（视图给的是用户输入，别让它把窗口导航到 file: / javascript:）
func normalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("url")
	}
	if len(raw) > maxURL {
		return "", errors.New("url too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("url")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("url scheme")
	}
	if u.Host == "" {
		return "", errors.New("url host")
	}
	return u.String(), nil
}

// showResult：ok / unsupported / failed 三种结果
func showResult(reason, message string) ShowResult {
	if reason == "" {
		return ShowResult{OK: true}
	}
	msg := message
	return ShowResult{OK: false, Reason: &reason, Message: &msg}
}

// Show：打开（或复用）贴在 region 上的原生窗口。
//
// 外壳不支持（浏览器预览 / 没有原生窗口实现）→ ok=false, reason=unsupported；
// 建窗失败（比如系统不允许新窗口）→ ok=false, reason=failed, message=原因。
func (m *Manager) Show(id, rawURL string, region Region) ShowResult {
	return m.ShowOwned(id, rawURL, region, 0)
}

// ShowOwned：同 Show，但把窗口记到 owner（调用方连接）名下。
//
// 同一个 id 被另一个连接重新 show 时 owner 改记新连接：谁最后在用它，谁负责它的存活。
func (m *Manager) ShowOwned(id, rawURL string, region Region, owner int) ShowResult {
	if id == "" || len(id) > maxID {
		return showResult("failed", "id")
	}
	target, err := normalizeURL(rawURL)
	if err != nil {
		return showResult("failed", err.Error())
	}
	opener := m.opener
	host := shell.BrowserHost(nil)
	if opener != nil {
		host = opener()
	}
	if host == nil {
		return showResult("unsupported", "")
	}
	events := shell.BrowserEvents{
		Loaded: func(u string, ok bool, message string) { m.loaded(id, u, ok, message) },
		Closed: func() { m.closed(id) },
	}
	m.mu.Lock()
	cur := m.open[id]
	if cur == nil && len(m.open) >= maxWindows {
		m.mu.Unlock()
		return showResult("failed", "too many windows")
	}
	m.open[id] = &state{url: target, region: region, visible: true, owner: owner}
	m.mu.Unlock()
	if cur != nil {
		// 已经开着：换地址 + 重新贴位（保持窗口不重建，页面状态留着）
		if err := host.OpenBrowser(id, target, shell.BrowserRegion(region), events); err != nil {
			return showResult("failed", err.Error())
		}
		host.SetBrowserRegion(id, shell.BrowserRegion(region), true)
		return showResult("", "")
	}
	if err := host.OpenBrowser(id, target, shell.BrowserRegion(region), events); err != nil {
		m.mu.Lock()
		delete(m.open, id)
		m.mu.Unlock()
		return showResult("failed", err.Error())
	}
	return showResult("", "")
}

// SetRegion：重新贴位；visible=false 时先藏起来（切标签、收面板、对话窗口最小化）
func (m *Manager) SetRegion(id string, region Region, visible bool) bool {
	host := m.host()
	m.mu.Lock()
	st := m.open[id]
	if st != nil {
		st.region = region
		st.visible = visible
	}
	m.mu.Unlock()
	if host == nil || st == nil {
		return false
	}
	host.SetBrowserRegion(id, shell.BrowserRegion(region), visible)
	return true
}

// Navigate：换地址；没开着时 false（视图据此重新 show）
func (m *Manager) Navigate(id, rawURL string) bool {
	target, err := normalizeURL(rawURL)
	if err != nil {
		return false
	}
	host := m.host()
	m.mu.Lock()
	st := m.open[id]
	if st != nil {
		st.url = target
	}
	m.mu.Unlock()
	if host == nil || st == nil {
		return false
	}
	if err := host.NavigateBrowser(id, target); err != nil {
		return false
	}
	return true
}

// Reload：重新加载当前页
func (m *Manager) Reload(id string) bool {
	host := m.host()
	m.mu.Lock()
	st := m.open[id]
	m.mu.Unlock()
	if host == nil || st == nil {
		return false
	}
	host.ReloadBrowser(id)
	return true
}

// Close：关掉窗口（标签关掉 / 换成别的标签）
//
// 幂等且不信任自己的记录：即使 map 里已经没这个 id（视图重载过、上一轮已删掉但原始窗口还活着），
// 也要把关闭送到外壳——否则就出现「标签已经关了，窗口还浮在屏幕上」。
func (m *Manager) Close(id string) bool {
	if id == "" || len(id) > maxID {
		return false
	}
	host := m.host()
	m.mu.Lock()
	st := m.open[id]
	delete(m.open, id)
	m.mu.Unlock()
	if host == nil {
		return false
	}
	// 不管记录在不在，都让外壳收一遍（外壳侧也幂等）
	host.CloseBrowser(id)
	return st != nil
}

// CloseAll：对话窗口关掉 / 应用退出时收尾
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.open))
	for id := range m.open {
		ids = append(ids, id)
	}
	m.open = map[string]*state{}
	m.mu.Unlock()
	host := m.host()
	if host == nil {
		return
	}
	for _, id := range ids {
		host.CloseBrowser(id)
	}
}

// Sync：视图报「我这一侧现在开着的 id 全集」，把不在这份清单里的窗口收掉（空清单 = 一个都不留）。
//
// 这是「关标签」真正靠得住的那条路：只会失败的局部通知（close(id) 打空了、视图重建后没人记得旧 id、
// 热更新把模块整个换掉）都不影响结果——只要它不在当前挂载的清单里，窗口就会被收走。
// owner > 0 时只动这条连接开的窗口，别的窗口（另一个对话窗口）不渠。
func (m *Manager) Sync(owner int, ids []string) []string {
	want := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" && len(id) <= maxID {
			want[id] = struct{}{}
		}
	}
	m.mu.Lock()
	gone := make([]string, 0, len(m.open))
	for id, st := range m.open {
		if _, keep := want[id]; keep {
			continue
		}
		if owner > 0 && st.owner != owner {
			continue
		}
		gone = append(gone, id)
		delete(m.open, id)
	}
	m.mu.Unlock()
	host := m.host()
	if host == nil {
		return gone
	}
	for _, id := range gone {
		host.CloseBrowser(id)
	}
	return gone
}

// CloseOwner：把 owner 名下的窗口全收掉（连接断开 = 窗口销毁 / 热更新重连）；owner <= 0 表示全部
func (m *Manager) CloseOwner(owner int) {
	if owner <= 0 {
		m.CloseAll()
		return
	}
	m.Sync(owner, nil)
}

// watch：每条连接只挂一次「断开就把它的窗口收掉」。
//
// 视图整页重载 / 热更新时连接会重开，旧连接一断，它开的原生视图就没人认领了，得靠这个收。
func (m *Manager) watch(c contract.Caller) {
	if c.Done == nil || c.ID <= 0 {
		return
	}
	m.watchMu.Lock()
	if m.watched[c.ID] {
		m.watchMu.Unlock()
		return
	}
	m.watched[c.ID] = true
	m.watchMu.Unlock()
	go func() {
		<-c.Done
		m.watchMu.Lock()
		delete(m.watched, c.ID)
		m.watchMu.Unlock()
		m.CloseOwner(c.ID)
	}()
}

func (m *Manager) host() shell.BrowserHost {
	if m.opener == nil {
		return nil
	}
	return m.opener()
}

// loaded：页面加载完成（外壳回调）→ 推给视图收掉进度条
func (m *Manager) loaded(id, u string, ok bool, message string) {
	m.mu.Lock()
	st := m.open[id]
	if st != nil && u != "" {
		st.url = u
	}
	m.mu.Unlock()
	if st == nil || m.emit == nil {
		return
	}
	payload := map[string]any{"id": id, "ok": ok}
	if u != "" {
		payload["url"] = u
	}
	if message != "" {
		payload["message"] = message
	}
	m.emit("browserWindow.loaded", payload)
}

// closed：原生窗口没了 → 忘掉它，并让视图回到回退页
func (m *Manager) closed(id string) {
	m.mu.Lock()
	_, had := m.open[id]
	delete(m.open, id)
	m.mu.Unlock()
	if had && m.emit != nil {
		m.emit("browserWindow.closed", map[string]any{"id": id})
	}
}

// Open：同 Show，返回 error（测试与内部调用方便）
func (m *Manager) Open(id, rawURL string, region Region) error {
	r := m.Show(id, rawURL, region)
	if r.OK {
		return nil
	}
	msg := ""
	if r.Message != nil {
		msg = *r.Message
	}
	reason := ""
	if r.Reason != nil {
		reason = *r.Reason
	}
	if msg == "" {
		msg = reason
	}
	return errors.New(msg)
}

// Register 把 browserWindow.* 挂到 Router（契约见 packages/contract/src/app/shell/browserWindow.ts）
func Register(r *contract.Router, m *Manager) {
	type regionIn struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	}
	toRegion := func(in regionIn) Region {
		return Region{
			X:      int(math.Round(in.X)),
			Y:      int(math.Round(in.Y)),
			Width:  max0(int(math.Round(in.Width))),
			Height: max0(int(math.Round(in.Height))),
		}
	}

	r.Call("browserWindow.show", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID     string   `json:"id"`
			URL    string   `json:"url"`
			Region regionIn `json:"region"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		m.watch(c)
		return m.ShowOwned(in.ID, in.URL, toRegion(in.Region), c.ID), nil
	})
	r.Call("browserWindow.setRegion", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID      string   `json:"id"`
			Region  regionIn `json:"region"`
			Visible bool     `json:"visible"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.SetRegion(in.ID, toRegion(in.Region), in.Visible), nil
	})
	r.Call("browserWindow.navigate", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.Navigate(in.ID, in.URL), nil
	})
	r.Call("browserWindow.reload", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.Reload(in.ID), nil
	})
	r.Call("browserWindow.close", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.Close(in.ID), nil
	})
	r.Call("browserWindow.closeAll", func(_ context.Context, c contract.Caller, _ json.RawMessage) (any, error) {
		m.watch(c)
		m.CloseOwner(c.ID)
		return true, nil
	})
	r.Call("browserWindow.sync", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		m.watch(c)
		closed := m.Sync(c.ID, in.IDs)
		if closed == nil {
			closed = []string{}
		}
		return map[string]any{"closed": closed}, nil
	})
}

func max0(v int) int {
	if v < 0 {
		return 0
	}
	return v
}
