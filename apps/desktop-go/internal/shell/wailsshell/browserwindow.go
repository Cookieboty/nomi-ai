package wailsshell

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// 内置浏览器（对话旁标签区的「浏览器」标签；开关、区域与 URL 校验在 core/browserwindow）。
//
// 网页必须放在**顶层文档**里：iframe 这种子框架会被目标站点的 X-Frame-Options / CSP
// frame-ancestors 拒掉（Google、GitHub 都拒嵌），自签证书还会被降级成「已阻止此内容」，
// 外部网页根本打不开。
//
// 载体是「宿主窗口里的一个原生子视图」，不是独立窗口——独立窗口做不到这些：
// 它有自己的层级（会浮在对话窗口之上，盖住设置页、弹层），得靠前端算坐标去贴，
// 界面一动就错位，关标签漏一次通知就泄漏。
//
//   - macOS：WKWebView 作为对话窗口 contentView 的子视图（browserwindow_darwin.go）
//   - Windows：WebView2 窗口 SetParent 成对话窗口的子窗口（browserwindow_windows.go）
//   - 其它（Linux / 没开 cgo 的 darwin）：独立无边框窗口（browserwindow_other.go）
//
// 前两种随窗口移动 / 缩放、被窗口裁剪、最小化时跟着消失，层级问题从根上没有了。

// browserView：平台相关的载体。区域一律是「相对对话窗口内容区左上角」的 CSS px，
// 由各平台换算成子视图 frame / 子窗口坐标。
type browserView interface {
	// SetRegion 摆放；返回 false 表示这块区域现在摆不了（太小 / 窗口还没布局）
	SetRegion(region shell.BrowserRegion) bool
	Show()
	Hide()
	Load(url string)
	Reload()
	Close()
}

// browserViewEvents：载体回报的事件
type browserViewEvents struct {
	Loaded func(ok bool, message string)
	Closed func()
}

// browserWin：一个开着的浏览器
//
// visible / revealed / shown 分开记：
//   - visible：视图说这块区域在屏上（标签在前台、面板展开、没有被整页视图盖住）
//   - revealed：第一次亮出来过了（等首次加载完成，免得先闪一下白底）
//   - shown：载体当前是显示状态（Show / Hide 的账要记，不然切回来时不会重新显示）
type browserWin struct {
	view     browserView
	region   shell.BrowserRegion
	url      string
	visible  bool
	revealed bool
	shown    bool
	events   shell.BrowserEvents
}

// browserLoadTimeout：页面迟迟没触发加载完成时也要亮出来（有的站点一直挂着连接）
const browserLoadTimeout = 1200 * time.Millisecond

// 区域小到这个程度时先不摆：面板刚展开 / 收起一半，缩成一条缝反而闪
const (
	minBrowserWidth  = 120
	minBrowserHeight = 80
)

// browserName：窗口名（只给容器型平台用，不直接用标签 id：可能很长、带任意字符）
func browserName(id string) string {
	sum := sha1.Sum([]byte(id))
	return shell.BrowserWindowPrefix + hex.EncodeToString(sum[:6])
}

func (w *Wails) browserFor(id string) *browserWin {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.browsers[id]
}

// OpenBrowser：建载体并加载 url，摆在 region 上；同一个 id 已开着时换地址并重新摆位
func (w *Wails) OpenBrowser(id, target string, region shell.BrowserRegion, ev shell.BrowserEvents) error {
	if w.app == nil {
		return errors.New("no app")
	}
	if b := w.browserFor(id); b != nil {
		w.mu.Lock()
		b.events = ev
		b.region = region
		b.visible = true
		navigate := target != b.url
		b.url = target
		w.mu.Unlock()
		if navigate {
			b.view.Load(target)
		}
		w.showBrowser(b)
		return nil
	}
	b := &browserWin{region: region, url: target, visible: true, events: ev}
	view, err := w.newBrowserView(id, target, region, browserViewEvents{
		Loaded: func(ok bool, message string) { w.browserLoaded(id, b, ok, message) },
		Closed: func() { w.browserGone(id, b) },
	})
	if err != nil {
		return err
	}
	b.view = view
	w.mu.Lock()
	w.browsers[id] = b
	w.mu.Unlock()
	// 页面加载完成再亮出来（免得先闪一下白底）；一直不完成的站点靠超时兜底
	time.AfterFunc(browserLoadTimeout, func() {
		if w.browserFor(id) == b {
			w.showBrowser(b)
		}
	})
	return nil
}

func (w *Wails) browserLoaded(id string, b *browserWin, ok bool, message string) {
	if w.browserFor(id) != b {
		return
	}
	w.showBrowser(b)
	w.mu.Lock()
	evs, target := b.events, b.url
	w.mu.Unlock()
	if evs.Loaded != nil {
		evs.Loaded(target, ok, message)
	}
}

// browserGone：载体自己没了（窗口被系统关掉 / 网页崩溃）
func (w *Wails) browserGone(id string, b *browserWin) {
	w.mu.Lock()
	cur := w.browsers[id] == b
	if cur {
		delete(w.browsers, id)
	}
	events := b.events
	w.mu.Unlock()
	if cur && events.Closed != nil {
		go events.Closed()
	}
}

// showBrowser：亮出来并按当前区域摆位；已经亮着时只重新摆位
func (w *Wails) showBrowser(b *browserWin) {
	if b.view == nil {
		return
	}
	w.mu.Lock()
	region, visible := b.region, b.visible
	b.revealed = true
	w.mu.Unlock()
	if !visible {
		return
	}
	// 区域摆不了（面板收着、在 hidden 容器里、窗口还没布局）：先藏着，
	// 不然载体停在旧位置，看着就像「浮在界面上」
	if !b.view.SetRegion(region) {
		w.hideBrowser(b)
		return
	}
	w.mu.Lock()
	needShow := !b.shown
	b.shown = true
	w.mu.Unlock()
	if needShow {
		b.view.Show()
	}
}

// hideBrowser：藏起来（切标签、收面板、被整页视图盖住）
func (w *Wails) hideBrowser(b *browserWin) {
	if b.view == nil {
		return
	}
	w.mu.Lock()
	needHide := b.shown
	b.shown = false
	w.mu.Unlock()
	if needHide {
		b.view.Hide()
	}
}

// SetBrowserRegion：更新区域；visible=false 时先藏起来（切标签、收面板、被整页视图盖住）
func (w *Wails) SetBrowserRegion(id string, region shell.BrowserRegion, visible bool) {
	b := w.browserFor(id)
	if b == nil {
		return
	}
	w.mu.Lock()
	b.region = region
	b.visible = visible
	w.mu.Unlock()
	if !visible {
		w.hideBrowser(b)
		return
	}
	w.showBrowser(b)
}

// NavigateBrowser：换地址
func (w *Wails) NavigateBrowser(id, target string) error {
	b := w.browserFor(id)
	if b == nil {
		return errors.New("no browser")
	}
	w.mu.Lock()
	b.url = target
	w.mu.Unlock()
	b.view.Load(target)
	return nil
}

// ReloadBrowser：重新加载当前页（用户可能已经在里面点进别的页面了）
func (w *Wails) ReloadBrowser(id string) {
	if b := w.browserFor(id); b != nil {
		b.view.Reload()
	}
}

// CloseBrowser：关掉并释放。幂等：记录里没有也照样让载体收一遍。
func (w *Wails) CloseBrowser(id string) {
	w.mu.Lock()
	b := w.browsers[id]
	delete(w.browsers, id)
	w.mu.Unlock()
	if b != nil && b.view != nil {
		b.view.Close()
		return
	}
	w.closeStrayBrowser(id)
}

// syncBrowsers：按记下的区域重新摆位（拖分隔条、对话窗口缩放后的兜底）
func (w *Wails) syncBrowsers(reveal bool) {
	w.mu.Lock()
	list := make([]*browserWin, 0, len(w.browsers))
	for _, b := range w.browsers {
		list = append(list, b)
	}
	w.mu.Unlock()
	for _, b := range list {
		w.mu.Lock()
		visible, revealed := b.visible, b.revealed
		w.mu.Unlock()
		if !visible {
			w.hideBrowser(b)
			continue
		}
		if !revealed && !reveal {
			continue
		}
		w.showBrowser(b)
	}
}

// reflowBrowsers：把重排合并成每 16ms 一次（窗口拖动 / 缩放时事件很密）
func (w *Wails) reflowBrowsers(reveal bool) {
	w.mu.Lock()
	if w.browserTimer != nil {
		w.browserTimer.Stop()
	}
	w.browserTimer = time.AfterFunc(16*time.Millisecond, func() { w.syncBrowsers(reveal) })
	w.mu.Unlock()
}

func (w *Wails) hideBrowsers() {
	w.mu.Lock()
	list := make([]*browserWin, 0, len(w.browsers))
	for _, b := range w.browsers {
		list = append(list, b)
	}
	w.mu.Unlock()
	for _, b := range list {
		w.hideBrowser(b)
	}
}

func (w *Wails) closeBrowsers() {
	w.mu.Lock()
	list := make([]*browserWin, 0, len(w.browsers))
	for id, b := range w.browsers {
		list = append(list, b)
		delete(w.browsers, id)
	}
	w.mu.Unlock()
	for _, b := range list {
		if b.view != nil {
			b.view.Close()
		}
	}
}

// usableRegion：区域够不够摆（平台无关的判定，各平台换算前都先过一遍）
func usableRegion(region shell.BrowserRegion) bool {
	return region.Width >= minBrowserWidth && region.Height >= minBrowserHeight
}

// regionToView：区域（视图 CSS px，左上原点）→ NSView 坐标（左下原点）
// macOS 的视图坐标 y 向上，换算要减掉自身高度；Windows 的子窗口用父窗口客户区左上原点，
// 跟视图给的是同一套坐标，不需要翻转。
func regionToView(region shell.BrowserRegion, contentHeight float64) (x, y, w, h float64, ok bool) {
	if !usableRegion(region) || contentHeight <= 0 {
		return 0, 0, 0, 0, false
	}
	return float64(region.X),
		contentHeight - float64(region.Y) - float64(region.Height),
		float64(region.Width),
		float64(region.Height),
		true
}

// browserRect：区域（相对对话窗口内容区）→ 屏幕绝对坐标，纯计算便于单测（全部是 DIP = 视图 CSS px）。
//
// 只有容器型平台（独立窗口）用得上：子视图 / 子窗口靠「相对内容区」这一套坐标自己跟着窗口走。
func browserRect(chat application.Rect, offX, offY int, region shell.BrowserRegion) (application.Rect, bool) {
	if chat.Width <= 0 || chat.Height <= 0 {
		return application.Rect{}, false
	}
	if !usableRegion(region) {
		return application.Rect{}, false
	}
	return application.Rect{
		X:      chat.X + offX + region.X,
		Y:      chat.Y + offY + region.Y,
		Width:  region.Width,
		Height: region.Height,
	}, true
}

// browserHoldsKeyboardFocus：浏览器子窗口（含网页内部控件）现在拿着键盘焦点吗（Windows 用）。
//
// 子窗口藏掉 / 关掉之后 Windows 不会把焦点交还给对话窗口的 WebView2：对话页面上光标看着还在输入框里，
// 键盘消息却进不去。所以藏 / 关之前先看焦点在不在它身上，在的话之后显式还回去。
// （macOS 在 browserwindow_darwin.m 的 nomi_release_focus 里按 superview 链做同样的判断。）
//
//   - active：对话窗口是不是前台窗口（别的应用在前台时什么都不该抢）；
//   - child：浏览器子窗口；focused：现在的焦点控件（GetFocus）；parent：控件的父窗口（GetParent）。
//
// 焦点控件是 child 或它的子孙时才返回 true；child / focused 为 0 时不动。
func browserHoldsKeyboardFocus(active bool, child, focused uintptr, parent func(uintptr) uintptr) bool {
	if !active || child == 0 || focused == 0 {
		return false
	}
	return focused == child || descendantOf(focused, child, parent)
}

// browserDescendMaxDepth：父链最多找这么多层（销毁途中父链可能成环）
const browserDescendMaxDepth = 32

func descendantOf(node, child uintptr, parent func(uintptr) uintptr) bool {
	for i := 0; i < browserDescendMaxDepth; i++ {
		next := parent(node)
		if next == 0 {
			return false
		}
		if next == child {
			return true
		}
		node = next
	}
	return false
}

// browserPopupJS：目标站点的 target=_blank / window.open 点了不该没反应。
// 容器型平台（Wails 窗口）每次加载完成后注入；mac 的子视图走 WKNavigationDelegate，不需要这段。
const browserPopupJS = `(function(){
  try {
    var go = function(u){ try { if (typeof u === "string" && /^https?:\/\//i.test(u)) { location.href = u; return true; } } catch (e) {} return false; };
    document.addEventListener("click", function(ev){
      var t = ev.target;
      if (!t || typeof t.closest !== "function") return;
      var a = t.closest("a[target]");
      if (!a || !a.href) return;
      var target = (a.getAttribute("target") || "").toLowerCase();
      if (target === "" || target === "_self" || target === "_top" || target === "_parent") return;
      ev.preventDefault();
      ev.stopPropagation();
      go(a.href);
    }, true);
    document.addEventListener("auxclick", function(ev){
      if (ev.button !== 1) return;
      var t = ev.target;
      if (!t || typeof t.closest !== "function") return;
      var a = t.closest("a[href]");
      if (!a || !a.href) return;
      ev.preventDefault();
      go(a.href);
    }, true);
    var open = window.open;
    window.open = function(u){ if (go(u)) return null; return open ? open.apply(window, arguments) : null; };
  } catch (e) {}
})();`
