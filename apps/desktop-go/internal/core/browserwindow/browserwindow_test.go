package browserwindow

import (
	"errors"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// fakeHost：记下外壳收到的调用，用来断言「核心只该要求这些」
type fakeHost struct {
	opened  []openedBrowser
	regions []regionCall
	naved   []string
	reloads []string
	closed  []string
	failOn  string
}

type openedBrowser struct {
	id     string
	url    string
	region shell.BrowserRegion
	events shell.BrowserEvents
}

type regionCall struct {
	id      string
	region  shell.BrowserRegion
	visible bool
}

func (f *fakeHost) OpenBrowser(id, url string, region shell.BrowserRegion, events shell.BrowserEvents) error {
	if f.failOn == url {
		return errors.New("window failed")
	}
	f.opened = append(f.opened, openedBrowser{id: id, url: url, region: region, events: events})
	return nil
}

func (f *fakeHost) SetBrowserRegion(id string, region shell.BrowserRegion, visible bool) {
	f.regions = append(f.regions, regionCall{id: id, region: region, visible: visible})
}

func (f *fakeHost) NavigateBrowser(id, url string) error {
	if f.failOn == url {
		return errors.New("navigate failed")
	}
	f.naved = append(f.naved, id+" "+url)
	return nil
}

func (f *fakeHost) ReloadBrowser(id string) { f.reloads = append(f.reloads, id) }

func (f *fakeHost) CloseBrowser(id string) { f.closed = append(f.closed, id) }

// newManager：带假外壳的 Manager（emit 记到切片里）
func newManager() (*Manager, *fakeHost, *[]string) {
	host := &fakeHost{}
	events := &[]string{}
	m := New(func() shell.BrowserHost { return host }, func(event string, data any) {
		*events = append(*events, event)
	})
	return m, host, events
}

func TestShowOpensWindowForHTTPOnly(t *testing.T) {
	for _, tc := range []struct {
		name   string
		url    string
		ok     bool
		reason string
	}{
		{name: "https", url: "https://example.com/docs", ok: true},
		{name: "http", url: "http://127.0.0.1:5173/", ok: true},
		{name: "blank", url: "   ", ok: false, reason: "failed"},
		{name: "javascript", url: "javascript:alert(1)", ok: false, reason: "failed"},
		{name: "file", url: "file:///etc/passwd", ok: false, reason: "failed"},
		{name: "no host", url: "https:///path", ok: false, reason: "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, host, _ := newManager()
			got := m.Show("browser:1", tc.url, Region{X: 10, Y: 20, Width: 800, Height: 600})
			if got.OK != tc.ok {
				t.Fatalf("ok = %v, want %v (message %v)", got.OK, tc.ok, got.Message)
			}
			if !tc.ok {
				if got.Reason == nil || *got.Reason != tc.reason {
					t.Fatalf("reason = %v, want %s", got.Reason, tc.reason)
				}
				if len(host.opened) != 0 {
					t.Fatalf("不该建窗，实际 %d 次", len(host.opened))
				}
				return
			}
			if len(host.opened) != 1 {
				t.Fatalf("建窗 %d 次，want 1", len(host.opened))
			}
			if host.opened[0].region != (shell.BrowserRegion{X: 10, Y: 20, Width: 800, Height: 600}) {
				t.Fatalf("region = %+v", host.opened[0].region)
			}
		})
	}
}

func TestShowUnsupportedWithoutHost(t *testing.T) {
	m := New(nil, nil)
	got := m.Show("browser:1", "https://example.com", Region{Width: 800, Height: 600})
	if got.OK {
		t.Fatal("没有外壳时不该报成功")
	}
	if got.Reason == nil || *got.Reason != "unsupported" {
		t.Fatalf("reason = %v, want unsupported", got.Reason)
	}
}

func TestShowReusesWindowForSameTab(t *testing.T) {
	m, host, _ := newManager()
	region := Region{X: 0, Y: 0, Width: 800, Height: 600}
	if got := m.Show("browser:1", "https://example.com", region); !got.OK {
		t.Fatalf("首次 show 失败：%v", got.Message)
	}
	if got := m.Show("browser:1", "https://example.com/next", region); !got.OK {
		t.Fatalf("复用失败：%v", got.Message)
	}
	// 同一个 id 复用窗口：外壳收到的是「换地址 + 重新贴位」，而不是又建一个窗口
	if len(host.opened) != 2 || host.opened[1].url != "https://example.com/next" {
		t.Fatalf("opened = %+v", host.opened)
	}
	if len(host.regions) != 1 || !host.regions[0].visible {
		t.Fatalf("regions = %+v", host.regions)
	}
}

func TestShowLimitsOpenWindows(t *testing.T) {
	m, _, _ := newManager()
	region := Region{Width: 800, Height: 600}
	for i := 0; i < maxWindows; i++ {
		id := "browser:" + string(rune('a'+i))
		if got := m.Show(id, "https://example.com", region); !got.OK {
			t.Fatalf("第 %d 个窗口失败：%v", i+1, got.Message)
		}
	}
	got := m.Show("browser:extra", "https://example.com", region)
	if got.OK {
		t.Fatal("超过上限还成功了")
	}
	if got.Message == nil || !strings.Contains(*got.Message, "too many") {
		t.Fatalf("message = %v", got.Message)
	}
	// 关掉一个就能再开
	m.Close("browser:a")
	if got := m.Show("browser:extra", "https://example.com", region); !got.OK {
		t.Fatalf("关掉窗口后仍开不了：%v", got.Message)
	}
}

func TestShowCleansUpWhenOpenFails(t *testing.T) {
	m, host, _ := newManager()
	host.failOn = "https://bad.example"
	region := Region{Width: 800, Height: 600}
	if got := m.Show("browser:1", "https://bad.example", region); got.OK {
		t.Fatal("建窗失败却报成功")
	}
	// 失败后不留状态：同一个 id 再试一次仍然走「建窗」而不是「复用」
	host.failOn = ""
	if got := m.Show("browser:1", "https://example.com", region); !got.OK {
		t.Fatalf("重试失败：%v", got.Message)
	}
	if len(host.opened) != 1 {
		t.Fatalf("opened = %+v", host.opened)
	}
}

func TestSetRegionForwardsVisibility(t *testing.T) {
	m, host, _ := newManager()
	m.Show("browser:1", "https://example.com", Region{Width: 800, Height: 600})
	if !m.SetRegion("browser:1", Region{X: 4, Y: 8, Width: 640, Height: 480}, false) {
		t.Fatal("SetRegion 应返回 true")
	}
	last := host.regions[len(host.regions)-1]
	if last.region != (shell.BrowserRegion{X: 4, Y: 8, Width: 640, Height: 480}) || last.visible {
		t.Fatalf("regions = %+v", host.regions)
	}
	// 没开着的 id：不惊动外壳
	if m.SetRegion("browser:none", Region{Width: 10, Height: 10}, true) {
		t.Fatal("没开着的窗口不该返回 true")
	}
}

func TestNavigateReloadClose(t *testing.T) {
	m, host, _ := newManager()
	region := Region{Width: 800, Height: 600}
	m.Show("browser:1", "https://example.com", region)

	if !m.Navigate("browser:1", "https://example.com/next") {
		t.Fatal("Navigate 应成功")
	}
	if len(host.naved) != 1 || host.naved[0] != "browser:1 https://example.com/next" {
		t.Fatalf("naved = %v", host.naved)
	}
	if m.Navigate("browser:1", "javascript:alert(1)") {
		t.Fatal("非法地址不该被导航")
	}
	if m.Navigate("browser:none", "https://example.com") {
		t.Fatal("没开着的窗口不该导航")
	}
	if !m.Reload("browser:1") {
		t.Fatal("Reload 应成功")
	}
	if len(host.reloads) != 1 {
		t.Fatalf("reloads = %v", host.reloads)
	}
	if !m.Close("browser:1") {
		t.Fatal("Close 应成功")
	}
	if len(host.closed) != 1 || host.closed[0] != "browser:1" {
		t.Fatalf("closed = %v", host.closed)
	}
}

// 关标签时走到 Close；但有时视图只发得出一次 close，或者记录已经被上一轮删掉了。
// 无论哪种，关闭都得送到外壳，不能因为「我这边的记录没了」就不管。
func TestCloseAlwaysReachesHost(t *testing.T) {
	m, host, _ := newManager()
	m.Show("browser:1", "https://example.com", Region{Width: 800, Height: 600})
	if m.Close("browser:1") != true {
		t.Fatal("第一次 Close 应返回 true")
	}
	if m.Close("browser:1") != false {
		t.Fatal("第二次 Close 应返回 false")
	}
	// 两次都要送到外壳（外壳侧幂等）
	if len(host.closed) != 2 {
		t.Fatalf("closed = %v", host.closed)
	}
	// 空 id 不碰外壳
	m.Close("")
	if len(host.closed) != 2 {
		t.Fatalf("空 id 不该通知外壳，closed = %v", host.closed)
	}
}

func TestCloseAllClosesEveryWindow(t *testing.T) {
	m, host, _ := newManager()
	region := Region{Width: 800, Height: 600}
	m.Show("browser:a", "https://example.com", region)
	m.Show("browser:b", "https://example.com", region)
	m.CloseAll()
	if len(host.closed) != 2 {
		t.Fatalf("closed = %v", host.closed)
	}
	// 关完之后可以重新开（状态干净）
	if got := m.Show("browser:a", "https://example.com", region); !got.OK {
		t.Fatalf("CloseAll 之后重开失败：%v", got.Message)
	}
}

func TestHostEventsReachTheView(t *testing.T) {
	m, host, events := newManager()
	m.Show("browser:1", "https://example.com", Region{Width: 800, Height: 600})
	callbacks := host.opened[0].events

	callbacks.Loaded("https://example.com", true, "")
	if len(*events) != 1 || (*events)[0] != "browserWindow.loaded" {
		t.Fatalf("events = %v", *events)
	}

	callbacks.Closed()
	if len(*events) != 2 || (*events)[1] != "browserWindow.closed" {
		t.Fatalf("events = %v", *events)
	}
	// 窗口已经没了：返回 false（没东西可关），但仍会把关闭送到外壳——外壳侧幂等，
	// 这样「记录没了、屏幕上还留着一个」的残留也能被收掉
	if m.Close("browser:1") {
		t.Fatal("Closed 之后不该再返回 true")
	}
	if len(host.closed) != 1 || host.closed[0] != "browser:1" {
		t.Fatalf("残留窗口也该通知外壳关，closed = %v", host.closed)
	}
}

func TestNormalizeURLKeepsQuery(t *testing.T) {
	got, err := normalizeURL("  https://example.com/a?b=1#c  ")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "https://example.com/a?b=1#c" {
		t.Fatalf("got = %q", got)
	}
	long := "https://example.com/" + strings.Repeat("a", maxURL)
	if _, err := normalizeURL(long); err == nil {
		t.Fatal("超长地址应当报错")
	}
}

// has：切片里有没有这个值（Sync 返回的顺序不定，断言只看集合）
func has(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// 关标签真正靠的是这条：只要不在「现在开着的清单」里就收掉，
// 不依赖某一次 close(id) 有没有送到（视图重建 / id 对不上时那条会打空）。
func TestSyncClosesWindowsNotInTheList(t *testing.T) {
	m, host, _ := newManager()
	m.Show("browser:keep", "https://example.com/a", Region{X: 0, Y: 0, Width: 600, Height: 400})
	m.Show("browser:gone", "https://example.com/b", Region{X: 0, Y: 0, Width: 600, Height: 400})

	closed := m.Sync(0, []string{"browser:keep"})

	if !has(closed, "browser:gone") || len(closed) != 1 {
		t.Fatalf("closed = %v, want only browser:gone", closed)
	}
	if !has(host.closed, "browser:gone") {
		t.Fatalf("外壳收到关闭 = %v，want browser:gone", host.closed)
	}
	if has(host.closed, "browser:keep") {
		t.Fatalf("清单里的窗口被误关了：%v", host.closed)
	}
	// 还开着的那个仍然能被后续操作找到
	if got := m.SetRegion("browser:keep", Region{X: 0, Y: 0, Width: 600, Height: 400}, true); !got {
		t.Fatal("browser:keep 不该被 Sync 删掉")
	}
}

// 空清单 = 一个都不该开着（页面卸载 / 热更新时说「都不要了」）
func TestSyncWithEmptyListClosesEverything(t *testing.T) {
	m, host, _ := newManager()
	m.Show("browser:1", "https://example.com/a", Region{X: 0, Y: 0, Width: 600, Height: 400})
	m.Show("browser:2", "https://example.com/b", Region{X: 0, Y: 0, Width: 600, Height: 400})

	if closed := m.Sync(0, nil); len(closed) != 2 {
		t.Fatalf("closed = %v, want 2 个", closed)
	}
	if len(host.closed) != 2 {
		t.Fatalf("外壳收到关闭 %d 次，want 2", len(host.closed))
	}
}

// 另一个对话窗口的浏览器不能被这条连接的清单带走
func TestSyncLeavesOtherOwnersAlone(t *testing.T) {
	m, host, _ := newManager()
	m.ShowOwned("browser:mine", "https://example.com/a", Region{X: 0, Y: 0, Width: 600, Height: 400}, 7)
	m.ShowOwned("browser:theirs", "https://example.com/b", Region{X: 0, Y: 0, Width: 600, Height: 400}, 8)

	closed := m.Sync(7, nil)

	if !has(closed, "browser:mine") || has(closed, "browser:theirs") {
		t.Fatalf("closed = %v, want 只关 browser:mine", closed)
	}
	if has(host.closed, "browser:theirs") {
		t.Fatalf("把别的连接的窗口关了：%v", host.closed)
	}
}

// 连接断开（窗口销毁 / 热更新重连）：它开过的浏览器得一起收掉，否则永远浮在屏幕上
func TestCloseOwnerCollectsItsWindows(t *testing.T) {
	m, host, _ := newManager()
	m.ShowOwned("browser:a", "https://example.com/a", Region{X: 0, Y: 0, Width: 600, Height: 400}, 3)
	m.ShowOwned("browser:b", "https://example.com/b", Region{X: 0, Y: 0, Width: 600, Height: 400}, 3)
	m.ShowOwned("browser:c", "https://example.com/c", Region{X: 0, Y: 0, Width: 600, Height: 400}, 4)

	m.CloseOwner(3)

	if len(host.closed) != 2 || !has(host.closed, "browser:a") || !has(host.closed, "browser:b") {
		t.Fatalf("外壳收到关闭 = %v，want browser:a + browser:b", host.closed)
	}
	if has(host.closed, "browser:c") {
		t.Fatalf("把别的连接的窗口关了：%v", host.closed)
	}
}

// 同一个标签被新连接重新打开：窗口改记新连接，旧连接断开时不能再把它收走
func TestShowOwnedMovesWindowToNewOwner(t *testing.T) {
	m, host, _ := newManager()
	region := Region{X: 0, Y: 0, Width: 600, Height: 400}
	m.ShowOwned("browser:x", "https://example.com/a", region, 5)
	m.ShowOwned("browser:x", "https://example.com/a", region, 6)

	m.CloseOwner(5)

	if has(host.closed, "browser:x") {
		t.Fatalf("窗口已归新连接，旧连接断开不该关它：%v", host.closed)
	}
	m.CloseOwner(6)
	if !has(host.closed, "browser:x") {
		t.Fatalf("新连接断开后该关：%v", host.closed)
	}
}
