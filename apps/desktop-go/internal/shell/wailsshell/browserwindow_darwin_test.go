//go:build darwin && cgo

package wailsshell

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"
)

var mainQueue = make(chan func())

func TestMain(m *testing.M) {
	runtime.LockOSThread()
	darwinInitAppForTest()

	done := make(chan int, 1)
	go func() {
		done <- m.Run()
	}()

	for {
		select {
		case code := <-done:
			os.Exit(code)
		case fn := <-mainQueue:
			fn()
		default:
			darwinPumpRunLoopForTest(0.01)
		}
	}
}

func runOnMain(fn func()) {
	ch := make(chan struct{})
	mainQueue <- func() {
		defer close(ch)
		fn()
	}
	<-ch
}

func pumpOnMainUntil(timeout time.Duration, pred func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ok := false
		runOnMain(func() {
			darwinPumpRunLoopForTest(0.02)
			ok = pred()
		})
		if ok {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func TestBrowserDarwinURLPolicy(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"http://127.0.0.1:8080/a", true},
		{"https://example.com/b?x=1", true},
		{"HTTPS://EXAMPLE.COM/path", true},
		{"file:///etc/passwd", false},
		{"javascript:alert(1)", false},
		{"data:text/html,hi", false},
		{"about:blank", false},
		{"mailto:a@b.com", false},
		{"https:///no-host", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := darwinURLAllowedForTest(tc.url); got != tc.want {
			t.Fatalf("darwinURLAllowedForTest(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestBrowserDarwinUIDelegateBindingAndNewWindowNavigation(t *testing.T) {
	type loadEvent struct {
		ok  bool
		msg string
	}
	loadCh := make(chan loadEvent, 8)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		switch r.URL.Path {
		case "/index":
			_, _ = fmt.Fprint(w, `<!doctype html><html><body style="margin:0">
<a id="normal" href="/normal" style="display:block;width:200px;height:60px">normal</a>
<a id="blank" href="/blank" target="_blank" style="display:block;width:200px;height:60px">blank</a>
<a id="bad" href="file:///etc/passwd" target="_blank" style="display:block;width:200px;height:60px">bad</a>
</body></html>`)
		case "/normal":
			_, _ = fmt.Fprint(w, `<!doctype html><html><body>normal page</body></html>`)
		case "/blank":
			_, _ = fmt.Fprint(w, `<!doctype html><html><body>blank page</body></html>`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	darwinBrowsersMu.Lock()
	darwinNextHandle++
	handle := darwinNextHandle
	darwinBrowsers[handle] = &darwinBrowser{
		handle: handle,
		events: browserViewEvents{
			Loaded: func(ok bool, msg string) {
				loadCh <- loadEvent{ok: ok, msg: msg}
			},
		},
	}
	darwinBrowsersMu.Unlock()
	defer func() {
		darwinBrowsersMu.Lock()
		delete(darwinBrowsers, handle)
		darwinBrowsersMu.Unlock()
	}()

	var nsWin unsafe.Pointer
	var view unsafe.Pointer
	indexURL := srv.URL + "/index"

	runOnMain(func() {
		nsWin = darwinNewWindowForTest()
		view = darwinCreateBrowserForTest(nsWin, int32(handle), indexURL)
	})
	if view == nil {
		t.Fatal("nomiBrowserCreate returned nil")
	}
	defer func() {
		runOnMain(func() {
			if !darwinCloseBrowserForTest(view) {
				t.Errorf("expected delegates cleared after close")
			}
			darwinCloseWindowForTest(nsWin)
		})
	}()

	var bound bool
	runOnMain(func() {
		bound = darwinDelegatesBoundForTest(view)
	})
	if !bound {
		t.Fatal("expected WKWebView to bind both WKNavigationDelegate and WKUIDelegate with JS popup disabled")
	}

	waitLoaded := func(wantSuffix string) {
		t.Helper()
		ok := pumpOnMainUntil(5*time.Second, func() bool {
			return strings.HasSuffix(darwinWebViewURLForTest(view), wantSuffix)
		})
		if !ok {
			var cur string
			runOnMain(func() { cur = darwinWebViewURLForTest(view) })
			t.Fatalf("timed out waiting for URL suffix %q, current=%q", wantSuffix, cur)
		}
		_ = pumpOnMainUntil(1*time.Second, func() bool {
			select {
			case ev := <-loadCh:
				return ev.ok
			default:
				return false
			}
		})
	}

	waitLoaded("/index")

	// 1. 普通链接点击导航（DOM click）
	runOnMain(func() {
		darwinEvalJSForTest(view, `document.getElementById('normal').click()`)
	})
	waitLoaded("/normal")

	// 回到 /index
	runOnMain(func() {
		darwinLoadBrowserForTest(view, indexURL)
	})
	waitLoaded("/index")

	// 2. 新窗口链接（target="_blank"）：先尝试模拟鼠标点击，离屏无聚焦窗口下再用 WKUIDelegate 直接触发动作
	runOnMain(func() {
		darwinClickPointForTest(nsWin, view, 40, 90)
	})
	clickedBlank := pumpOnMainUntil(800*time.Millisecond, func() bool {
		return strings.HasSuffix(darwinWebViewURLForTest(view), "/blank")
	})
	if !clickedBlank {
		runOnMain(func() {
			if !darwinInvokeCreateWebViewForTest(view, srv.URL+"/blank") {
				t.Errorf("createWebViewWithConfiguration should return nil")
			}
		})
		waitLoaded("/blank")
	}

	// 3. 非法 scheme 的新窗口链接（file:///etc/passwd）必须被忽略，停留在当前 /blank 页面
	runOnMain(func() {
		if !darwinInvokeCreateWebViewForTest(view, "file:///etc/passwd") {
			t.Errorf("createWebViewWithConfiguration should return nil for blocked URL")
		}
	})
	_ = pumpOnMainUntil(200*time.Millisecond, func() bool { return false })
	var afterBad string
	runOnMain(func() { afterBad = darwinWebViewURLForTest(view) })
	if !strings.HasSuffix(afterBad, "/blank") {
		t.Fatalf("blocked URL should not navigate away from /blank, got %q", afterBad)
	}
}
