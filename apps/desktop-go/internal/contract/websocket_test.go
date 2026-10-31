package contract_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
)

const testOrigin = "wails://wails"

// wsServer：真实 Router + 生成的过程表（procs.Install 给 diagnostics.* 上 chat 限制）；
// diagnostics.get 回调用方的界面，便于断言服务端认的身份
func wsServer(t *testing.T) *contract.WSServer {
	t.Helper()
	r := contract.NewRouter()
	r.Call("diagnostics.get", func(_ context.Context, c contract.Caller, _ json.RawMessage) (any, error) {
		return c.Surface, nil
	})
	r.Call("mascot.get", func(_ context.Context, c contract.Caller, _ json.RawMessage) (any, error) {
		return c.Surface, nil
	})
	procs.Install(r)
	s := &contract.WSServer{Router: r, Origins: map[string]bool{testOrigin: true}}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	return s
}

func dial(t *testing.T, s *contract.WSServer, origin, token, surface string) (*websocket.Conn, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	protos := []string{contract.WSProtocol, contract.WSTokenPrefix + token}
	if surface != "" {
		protos = append(protos, contract.WSSurfacePrefix+surface)
	}
	c, res, err := websocket.Dial(ctx, s.URL, &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": {origin}},
		Subprotocols: protos,
	})
	if err != nil {
		if res == nil {
			t.Fatalf("dial: %v", err)
		}
		return nil, res.StatusCode
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, http.StatusSwitchingProtocols
}

func send(t *testing.T, c *websocket.Conn, frame string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
		t.Fatal(err)
	}
}

func recv(t *testing.T, c *websocket.Conn, d time.Duration) (contract.ServerFrame, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		return contract.ServerFrame{}, err
	}
	var f contract.ServerFrame
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f, nil
}

func call(t *testing.T, c *websocket.Conn, id, name string) contract.ServerFrame {
	t.Helper()
	send(t, c, `{"t":"req","id":"`+id+`","kind":"call","name":"`+name+`"}`)
	f, err := recv(t, c, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// #183：caller 的界面由 token 决定；桌面角色窗口的 token 自报 chat 被拒，也拿不到 chat 专属过程
func TestWSSurfaceBoundToToken(t *testing.T) {
	s := wsServer(t)
	chatTok, _ := s.Issue("chat")
	mascotTok, _ := s.Issue("mascot")

	// chat token：照旧调 chat 专属过程
	chat, code := dial(t, s, testOrigin, chatTok, "chat")
	if chat == nil {
		t.Fatalf("chat token rejected: %d", code)
	}
	if f := call(t, chat, "1", "diagnostics.get"); f.T != "res" || f.Output != "chat" {
		t.Fatalf("chat diagnostics.get: %+v", f)
	}

	// 桌面角色 token 自报 chat：握手被拒
	if c, code := dial(t, s, testOrigin, mascotTok, "chat"); c != nil || code != http.StatusUnauthorized {
		t.Fatalf("mascot token declaring chat: conn=%v code=%d", c != nil, code)
	}
	// 桌面角色 token 按实报 mascot 连上，chat 专属过程被守卫拒绝，身份仍是 mascot
	mascot, code := dial(t, s, testOrigin, mascotTok, "mascot")
	if mascot == nil {
		t.Fatalf("mascot token rejected: %d", code)
	}
	if f := call(t, mascot, "2", "diagnostics.get"); f.T != "err" || f.Error == nil || f.Error.Code != "FORBIDDEN" {
		t.Fatalf("mascot diagnostics.get should be FORBIDDEN: %+v", f)
	}
	if f := call(t, mascot, "3", "mascot.get"); f.T != "res" || f.Output != "mascot" {
		t.Fatalf("mascot caller surface: %+v", f)
	}
	// chat token 自报 mascot 也拒（自报只用来核对）
	if c, code := dial(t, s, testOrigin, chatTok, "mascot"); c != nil || code != http.StatusUnauthorized {
		t.Fatalf("chat token declaring mascot: conn=%v code=%d", c != nil, code)
	}
}

// 原有的拒绝照旧：假 token、非法 Origin、缺失 / 非法界面
func TestWSRejects(t *testing.T) {
	s := wsServer(t)
	chatTok, _ := s.Issue("chat")
	for name, tc := range map[string]struct{ origin, token, surface string }{
		"bad token":       {testOrigin, contract.NewToken(), "chat"},
		"empty token":     {testOrigin, "", "chat"},
		"bad origin":      {"http://evil.example", chatTok, "chat"},
		"no surface":      {testOrigin, chatTok, ""},
		"unknown surface": {testOrigin, chatTok, "settings"},
	} {
		c, code := dial(t, s, tc.origin, tc.token, tc.surface)
		if c != nil || (code != http.StatusUnauthorized && code != http.StatusForbidden) {
			t.Errorf("%s: conn=%v code=%d", name, c != nil, code)
		}
	}
	defer func() {
		if recover() == nil {
			t.Error("Issue with an unknown surface should panic")
		}
	}()
	s.Issue("settings")
}

// 窗口关闭（revoke）：断开它的连接，旧 token 重连被拒；重建的窗口拿新 token，身份不串
func TestWSRevokeAndRecreate(t *testing.T) {
	s := wsServer(t)
	oldTok, revoke := s.Issue("mascot")
	c, code := dial(t, s, testOrigin, oldTok, "mascot")
	if c == nil {
		t.Fatalf("dial: %d", code)
	}
	revoke()
	revoke() // 可重复调用
	if _, err := recv(t, c, 5*time.Second); err == nil {
		t.Fatal("connection should be closed after revoke")
	}
	if c, code := dial(t, s, testOrigin, oldTok, "mascot"); c != nil || code != http.StatusUnauthorized {
		t.Fatalf("revoked token reconnect: conn=%v code=%d", c != nil, code)
	}

	newTok, _ := s.Issue("mascot")
	if newTok == oldTok {
		t.Fatal("re-created window got the old token")
	}
	if c, code := dial(t, s, testOrigin, newTok, "chat"); c != nil || code != http.StatusUnauthorized {
		t.Fatalf("new mascot token declaring chat: conn=%v code=%d", c != nil, code)
	}
	// 同一窗口断线重连（页面没关）：同一份 token 仍可用，身份不变
	for i := 0; i < 2; i++ {
		c, code := dial(t, s, testOrigin, newTok, "mascot")
		if c == nil {
			t.Fatalf("reconnect %d: %d", i, code)
		}
		if f := call(t, c, "1", "mascot.get"); f.Output != "mascot" {
			t.Fatalf("reconnect %d surface: %+v", i, f)
		}
		c.Close(websocket.StatusNormalClosure, "")
	}
}

// 同一 token 多条连接：撤销与连接自行断开同时发生（#208，配合 -race）
func TestWSRevokeRacesConnClose(t *testing.T) {
	s := wsServer(t)
	for round := 0; round < 5; round++ {
		tok, revoke := s.Issue("chat")
		var conns []*websocket.Conn
		for i := 0; i < 8; i++ {
			c, code := dial(t, s, testOrigin, tok, "chat")
			if c == nil {
				t.Fatalf("dial %d: %d", i, code)
			}
			conns = append(conns, c)
		}
		var wg sync.WaitGroup
		for _, c := range conns[:4] {
			wg.Add(1)
			go func(c *websocket.Conn) {
				defer wg.Done()
				c.Close(websocket.StatusNormalClosure, "")
			}(c)
		}
		revoke()
		wg.Wait()
		for _, c := range conns[4:] {
			if _, err := recv(t, c, 5*time.Second); err == nil {
				t.Fatal("connection should be closed after revoke")
			}
		}
	}
}

// 只给对话窗口的事件只送到 chat token 的连接（桌面角色连接订阅了也收不到）
func TestWSEventsFollowTokenSurface(t *testing.T) {
	s := wsServer(t)
	chatTok, _ := s.Issue("chat")
	mascotTok, _ := s.Issue("mascot")
	chat, _ := dial(t, s, testOrigin, chatTok, "chat")
	mascot, _ := dial(t, s, testOrigin, mascotTok, "mascot")
	if chat == nil || mascot == nil {
		t.Fatal("dial failed")
	}
	for _, c := range []*websocket.Conn{chat, mascot} {
		send(t, c, `{"t":"sub","event":"desktop.summary"}`)
		// 往返一次，确认 sub 已处理
		if f := call(t, c, "sync", "meta.version"); f.T != "res" {
			t.Fatalf("meta.version: %+v", f)
		}
	}
	if !s.Router.EmitTo("desktop.summary", 1, "chat") {
		t.Fatal("chat subscriber should receive")
	}
	if f, err := recv(t, chat, 5*time.Second); err != nil || f.T != "event" || f.Event != "desktop.summary" {
		t.Fatalf("chat event: %+v %v", f, err)
	}
	if f, err := recv(t, mascot, 200*time.Millisecond); err == nil {
		t.Fatalf("mascot got a chat-only event: %+v", f)
	}
}
