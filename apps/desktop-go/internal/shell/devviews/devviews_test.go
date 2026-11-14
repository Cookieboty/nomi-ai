package devviews

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/viewpage"
)

func TestParse(t *testing.T) {
	got, err := Parse("mascot=http://127.0.0.1:6127, chat=http://127.0.0.1:6128")
	if err != nil || len(got) != 2 || got["mascot"].Host != "127.0.0.1:6127" || got["chat"].Host != "127.0.0.1:6128" {
		t.Fatalf("got %v %v", got, err)
	}
	for _, bad := range []string{"mascot", "mascot=https://127.0.0.1:1", "mascot=http://10.0.0.1:1", "a/b=http://127.0.0.1:1", "=http://127.0.0.1:1"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}

func TestMiddlewareProxiesAndInjectsRuntime(t *testing.T) {
	var gotHost, gotPath string
	vite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost, gotPath = r.Host, r.URL.Path
		if strings.HasSuffix(r.URL.Path, "/") {
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<html><head><title>x</title></head><body></body></html>")
			return
		}
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = io.WriteString(w, "export {}")
	}))
	defer vite.Close()
	u, _ := url.Parse(vite.URL)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "embedded") })
	h := Middleware(map[string]*url.URL{"mascot": u})(next)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/mascot/", nil))
	if gotHost != u.Host || gotPath != "/mascot/" {
		t.Fatalf("proxied host=%q path=%q", gotHost, gotPath)
	}
	if body := rec.Body.String(); !strings.Contains(body, viewpage.RuntimeTag+"\n</head>") || !strings.Contains(body, viewpage.LogPrefix) {
		t.Fatalf("runtime not injected: %s", body)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/mascot/src/index.tsx", nil))
	if rec.Body.String() != "export {}" {
		t.Fatalf("js body changed: %q", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/__scheme/chat-asset/a.png", nil))
	if rec.Body.String() != "embedded" {
		t.Fatalf("non-view path should fall through, got %q", rec.Body.String())
	}
}

func TestMiddlewareCapsConcurrency(t *testing.T) {
	var cur, maxActive atomic.Int32
	vite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := cur.Add(1)
		for {
			prev := maxActive.Load()
			if n <= prev || maxActive.CompareAndSwap(prev, n) {
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
		cur.Add(-1)
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = io.WriteString(w, "export {}")
	}))
	defer vite.Close()

	u, _ := url.Parse(vite.URL)
	h := Middleware(map[string]*url.URL{"chat": u})(http.NotFoundHandler())

	const total = 120
	var wg sync.WaitGroup
	errs := make(chan int, total)
	for i := 0; i < total; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/chat/src/mod.js", nil))
			if rec.Code != http.StatusOK {
				errs <- rec.Code
			}
		}()
	}
	wg.Wait()
	close(errs)
	for code := range errs {
		t.Fatalf("unexpected status %d", code)
	}
	if peak := maxActive.Load(); peak > maxConnsPerTarget {
		t.Fatalf("peak concurrent upstream requests = %d, want <= %d", peak, maxConnsPerTarget)
	}
}

func TestMiddlewareRetriesTransientGetOnly(t *testing.T) {
	// 原始 TCP 监听：前两次直接 RST/关闭（模拟 backlog 满或对端重置），第三次起交给 HTTP 服务正常返回
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	var attempts atomic.Int32
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = io.WriteString(w, "ok")
		}),
	}
	defer srv.Close()

	ready := make(chan net.Conn, 4)
	cl := &chanListener{ln: ln, ch: ready, done: make(chan struct{})}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			n := attempts.Add(1)
			if n <= 2 {
				if tc, ok := c.(*net.TCPConn); ok {
					_ = tc.SetLinger(0)
				}
				_ = c.Close()
				continue
			}
			select {
			case ready <- c:
			case <-cl.done:
				_ = c.Close()
				return
			}
		}
	}()
	go srv.Serve(cl)

	u, _ := url.Parse("http://" + ln.Addr().String())
	h := Middleware(map[string]*url.URL{"chat": u})(http.NotFoundHandler())

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/chat/src/main.tsx", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("GET retry failed: status=%d body=%q attempts=%d", rec.Code, rec.Body.String(), attempts.Load())
	}

	// 非幂等 POST（带 body）不应重试
	attempts.Store(0)
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln2.Close()
	go func() {
		for {
			c, err := ln2.Accept()
			if err != nil {
				return
			}
			attempts.Add(1)
			if tc, ok := c.(*net.TCPConn); ok {
				_ = tc.SetLinger(0)
			}
			_ = c.Close()
		}
	}()
	u2, _ := url.Parse("http://" + ln2.Addr().String())
	h2 := Middleware(map[string]*url.URL{"chat": u2})(http.NotFoundHandler())
	rec2 := httptest.NewRecorder()
	h2.ServeHTTP(rec2, httptest.NewRequest("POST", "http://wails.localhost/chat/api", strings.NewReader("x=1")))
	if rec2.Code != http.StatusBadGateway || attempts.Load() != 1 {
		t.Fatalf("POST should fail without retry: status=%d attempts=%d", rec2.Code, attempts.Load())
	}

	// 请求被取消时立即停止重试
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("GET", "http://wails.localhost/chat/src/main.tsx", nil).WithContext(ctx)
	rec3 := httptest.NewRecorder()
	h2.ServeHTTP(rec3, req)
	if rec3.Code != http.StatusBadGateway {
		t.Fatalf("canceled GET status=%d want 502", rec3.Code)
	}
}

type chanListener struct {
	ln   net.Listener
	ch   <-chan net.Conn
	done chan struct{}
	once sync.Once
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.ch:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *chanListener) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *chanListener) Addr() net.Addr { return l.ln.Addr() }
