package desktop

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// 工具确认发到哪（同 core/tests/unit/desktop/confirmRouting.test.ts）：对话窗口开着 → 只发给对话窗口；
// 看板娘被关掉了 → 打开对话窗口，不把她叫出来；否则发给看板娘。请求文件夹在对话里问。

type sentEvent struct {
	ev      string
	payload any
	surface string
}

type routeEnv struct {
	s       *Service
	home    string
	mu      sync.Mutex
	sent    []sentEvent
	opened  int
	summons int
	picks   []string
}

func newRouteEnv(t *testing.T, chat, hidden bool) *routeEnv {
	t.Helper()
	home, _ := filepath.EvalSymlinks(t.TempDir())
	e := &routeEnv{home: home}
	ports := Ports{Home: home, PickDirectory: func(_, _, def string) string {
		e.mu.Lock()
		e.picks = append(e.picks, def)
		e.mu.Unlock()
		return ""
	}}
	e.s = CreateService(t.TempDir(), ports, func(ev string, p any, surface string) bool {
		e.mu.Lock()
		e.sent = append(e.sent, sentEvent{ev, p, surface})
		e.mu.Unlock()
		return true
	})
	e.s.AttachWindows(&Windows{
		Main:         func() bool { return !hidden },
		IsVisible:    func() bool { return !hidden },
		ShowInactive: func() {},
		OpenChat: func() {
			e.mu.Lock()
			e.opened++
			e.mu.Unlock()
		},
		MascotHidden: func() bool { return hidden },
		SummonMascot: func() {
			e.mu.Lock()
			e.summons++
			e.mu.Unlock()
		},
		ChatOpen: func() bool { return chat },
	})
	return e
}

// requests：发到 surface 的确认请求（等到至少 n 条或超时）
func (e *routeEnv) requests(t *testing.T, surface string, n int) []ConfirmRequest {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		var out []ConfirmRequest
		for _, x := range e.sent {
			if x.ev == "desktop.confirmRequest" && x.surface == surface {
				out = append(out, x.payload.(ConfirmRequest))
			}
		}
		e.mu.Unlock()
		if len(out) >= n || time.Now().After(deadline) {
			return out
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *routeEnv) ask(ctx context.Context) <-chan string {
	out := make(chan string, 1)
	go func() {
		out <- e.s.Broker.Authorize(AuthorizeInput{Tool: "fs_write_text", Danger: "write", Summary: "s", Args: map[string]any{}, Signal: ctx})
	}()
	return out
}

func TestConfirmRoutingChatOpen(t *testing.T) {
	e := newRouteEnv(t, true, false)
	d := e.ask(context.Background())
	reqs := e.requests(t, "chat", 1)
	if len(reqs) != 1 || len(e.requests(t, "mascot", 0)) != 0 {
		t.Fatalf("chat=%d mascot=%d", len(reqs), len(e.requests(t, "mascot", 0)))
	}
	e.s.AnswerConfirm("chat", reqs[0].ID, true, false, false)
	if got := <-d; got != "allowed" {
		t.Fatalf("decision %q", got)
	}
}

func TestConfirmRoutingMascotAndHidden(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e := newRouteEnv(t, false, false)
	e.ask(ctx)
	if n := len(e.requests(t, "mascot", 1)); n != 1 {
		t.Fatalf("mascot requests %d", n)
	}
	h := newRouteEnv(t, false, true)
	h.ask(ctx)
	if n := len(h.requests(t, "chat", 1)); n != 1 || h.opened != 1 || h.summons != 0 {
		t.Fatalf("hidden: chat=%d opened=%d summons=%d", n, h.opened, h.summons)
	}
}

func TestConfirmAnswerFromSettingsIgnored(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	e := newRouteEnv(t, true, false)
	d := e.ask(ctx)
	reqs := e.requests(t, "chat", 1)
	e.s.AnswerConfirm("settings", reqs[0].ID, true, false, false)
	if got := <-d; got != "denied" {
		t.Fatalf("decision %q", got)
	}
}

func TestRequestFolder(t *testing.T) {
	e := newRouteEnv(t, true, false)
	dir := filepath.Join(e.home, "proj")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	got := make(chan string, 1)
	go func() { got <- e.s.RequestFolder(context.Background(), dir, "read-write", "need the repo") }()
	req := e.requests(t, "chat", 1)[0]
	if req.Kind != "scope" || req.ScopePath != dir || req.ScopeMode != "read-write" || req.Preview == nil || *req.Preview != "need the repo" {
		t.Fatalf("scope request %+v", req)
	}
	e.s.AnswerConfirm("chat", req.ID, true, false, false)
	if p := <-got; p != dir || len(e.picks) != 0 {
		t.Fatalf("granted %q picks %v", p, e.picks)
	}

	// 主目录太宽：不提供一键授权；用户另选 → 打开选择框
	go func() { got <- e.s.RequestFolder(context.Background(), e.home, "read", "") }()
	req = e.requests(t, "chat", 2)[1]
	if req.Kind != "scope" || req.ScopePath != "" {
		t.Fatalf("broad suggestion offered: %+v", req)
	}
	e.s.AnswerConfirm("chat", req.ID, false, false, true)
	if p := <-got; p != "" || len(e.picks) != 1 || e.picks[0] != e.home {
		t.Fatalf("pick: %q %v", p, e.picks)
	}

	// 对话窗口没开：直接打开选择框
	c := newRouteEnv(t, false, false)
	if p := c.s.RequestFolder(context.Background(), "~/x", "read", ""); p != "" || len(c.picks) != 1 || c.picks[0] != filepath.Join(c.home, "x") {
		t.Fatalf("closed chat: %q %v", p, c.picks)
	}
}
