package contract

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

// callerSeq：每条连接一个调用方 id（契约 caller.id）
var callerSeq atomic.Int64

// 与 packages/contract/src/websocket.ts 一致
const (
	WSProtocol      = "nomi.contract.v1"
	WSTokenPrefix   = "nomi-token."
	WSSurfacePrefix = "nomi-surface."
)

// WSServer：只听 127.0.0.1，校验 Origin、token、surface（同 host-node/src/websocket.ts 的规则）。
//
// 每个窗口一份 token（Issue），服务端记 token → 界面：caller 的界面由 token 决定（同 Electron 由发送方
// webContents 判定，ipcSenderGuard.ts），子协议里自报的界面只用来核对，与 token 不符直接拒绝握手。
// 窗口关闭时撤销它的 token（Issue 返回的 revoke），同时断开还连着的连接，之后用这份 token 重连也被拒。
type WSServer struct {
	Router  *Router
	Origins map[string]bool
	URL     string
	ln      net.Listener

	mu     sync.Mutex
	grants map[string]*wsGrant // token → 窗口身份
}

// wsGrant：一份 token 绑定的界面，与用它连上的连接（撤销时断开）
type wsGrant struct {
	surface string
	conns   map[*context.CancelFunc]struct{}
}

// Issue 给一个窗口发 token，绑定界面 surface（chat / mascot）；返回的 revoke 撤销 token 并断开用它连上的连接
// （可重复调用）。窗口重建时发新 token，旧窗口关闭时撤销旧的。
func (s *WSServer) Issue(surface string) (token string, revoke func()) {
	if surface != "chat" && surface != "mascot" {
		panic("contract: no WebSocket surface " + surface)
	}
	token = NewToken()
	s.mu.Lock()
	if s.grants == nil {
		s.grants = map[string]*wsGrant{}
	}
	s.grants[token] = &wsGrant{surface: surface, conns: map[*context.CancelFunc]struct{}{}}
	s.mu.Unlock()
	return token, func() { s.revoke(token) }
}

func (s *WSServer) revoke(token string) {
	// g.conns 也会被 serve 退出时并发删除，锁内拷出来再锁外取消（#208）
	s.mu.Lock()
	var cancels []context.CancelFunc
	if g := s.grants[token]; g != nil {
		for c := range g.conns {
			cancels = append(cancels, *c)
		}
	}
	delete(s.grants, token)
	s.mu.Unlock()
	for _, c := range cancels {
		c()
	}
}

// grant 按 token 找窗口身份（逐个定长比较，不按 map 查找泄露时序）；调用方持有 s.mu
func (s *WSServer) grant(token string) *wsGrant {
	var found *wsGrant
	for t, g := range s.grants {
		if subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
			found = g
		}
	}
	return found
}

func NewToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *WSServer) Start() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	s.ln = ln
	s.URL = "ws://" + ln.Addr().String()
	go http.Serve(ln, http.HandlerFunc(s.serve))
	return nil
}

func (s *WSServer) serve(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.Origins[origin] {
		log.Printf("[ws] origin rejected: %q", origin)
		http.Error(w, "origin is not allowed", http.StatusForbidden)
		return
	}
	var token, surface string
	hasProto := false
	for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		p = strings.TrimSpace(p)
		switch {
		case p == WSProtocol:
			hasProto = true
		case strings.HasPrefix(p, WSTokenPrefix):
			token = p[len(WSTokenPrefix):]
		case strings.HasPrefix(p, WSSurfacePrefix):
			surface = p[len(WSSurfacePrefix):]
		}
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// 界面取 token 绑定的那个；自报的界面必须存在且与之一致（桌面角色的 token 自报 chat 被拒）
	s.mu.Lock()
	g := s.grant(token)
	ok := hasProto && token != "" && g != nil && surface == g.surface
	if ok {
		g.conns[&cancel] = struct{}{}
		defer func() {
			s.mu.Lock()
			delete(g.conns, &cancel)
			s.mu.Unlock()
		}()
	}
	s.mu.Unlock()
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{WSProtocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(16 << 20)
	var mu sync.Mutex
	sess := s.Router.NewSession(ctx, Caller{Surface: g.surface, ID: int(callerSeq.Add(1)), Done: ctx.Done()}, func(f ServerFrame) {
		b, err := EncodeWire(f)
		if err != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_ = c.Write(ctx, websocket.MessageText, b)
	})
	defer sess.Close()
	for {
		typ, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageText {
			sess.Handle(b)
		}
	}
}
