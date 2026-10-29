package contract

import (
	"context"
	"crypto/rand"
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

// WSServer：只听 127.0.0.1，校验 Origin、token、surface（同 host-node/src/websocket.ts 的规则）
type WSServer struct {
	Router  *Router
	Token   string
	Origins map[string]bool
	URL     string
	ln      net.Listener
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
	if !hasProto || token != s.Token || (surface != "chat" && surface != "mascot") {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{WSProtocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	c.SetReadLimit(16 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var mu sync.Mutex
	sess := s.Router.NewSession(ctx, Caller{Surface: surface, ID: int(callerSeq.Add(1)), Done: ctx.Done()}, func(f ServerFrame) {
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
