package mcpbridge

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/mcp"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// #213：连接时调用方取消 / 超时后，工厂迟到返回的 client 必须恰好被关闭一次，且不进服务列表

type lateClient struct {
	closes atomic.Int32
	closed chan struct{}
}

func newLateClient() *lateClient { return &lateClient{closed: make(chan struct{})} }

func (c *lateClient) ListTools(*u.Obj, *mcp.RequestOptions) (*u.Obj, error) {
	o := u.NewObj()
	o.Set("tools", []any{})
	return o, nil
}
func (c *lateClient) CallTool(string, *u.Obj, *mcp.RequestOptions) (*u.Obj, error) { return nil, nil }
func (c *lateClient) Close() error {
	if c.closes.Add(1) == 1 {
		close(c.closed)
	}
	return nil
}

func waitClosed(t *testing.T, c *lateClient) {
	t.Helper()
	select {
	case <-c.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("late client was never closed")
	}
	// 再让出一会儿：不能有第二次 Close
	time.Sleep(20 * time.Millisecond)
	if n := c.closes.Load(); n != 1 {
		t.Fatalf("late client closed %d times, want 1", n)
	}
}

func TestConnectCancelClosesLateClient(t *testing.T) {
	late := newLateClient()
	release := make(chan struct{})
	started := make(chan struct{})
	reg := tools.NewInMemory()
	s := New(Options{
		GetRegistry:      func() tools.Registry { return reg },
		ConnectTimeoutMs: 30_000,
		CreateClient: func(mcp.ClientConfig) (Client, error) {
			close(started)
			<-release // 取消之后才握手成功
			return late, nil
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- s.Connect(ctx, ServerConfig{ID: "a", Transport: "sse", URL: "http://x"}) }()
	<-started
	cancel()
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	close(release)
	waitClosed(t, late)
	if got := s.ListServers(); len(got) != 0 {
		t.Fatalf("servers = %+v", got)
	}
}

func TestConnectTimeoutClosesLateClient(t *testing.T) {
	late := newLateClient()
	release := make(chan struct{})
	s := New(Options{ConnectTimeoutMs: 1, CreateClient: func(mcp.ClientConfig) (Client, error) {
		<-release
		return late, nil
	}})
	if err := s.Connect(context.Background(), ServerConfig{ID: "a", Transport: "http", URL: "http://x"}); err == nil {
		t.Fatal("want timeout")
	}
	close(release)
	waitClosed(t, late)
}

func TestConnectPassesCancelableCtxToInitialization(t *testing.T) {
	var got mcp.ClientConfig
	ok := newLateClient()
	s := New(Options{CreateClient: func(c mcp.ClientConfig) (Client, error) { got = c; return ok, nil }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.Connect(ctx, ServerConfig{ID: "a", Transport: "http", URL: "http://x"}); err != nil {
		t.Fatal(err)
	}
	if got.InitializationOptions == nil || got.InitializationOptions.Signal != mcp.Signal(ctx) {
		t.Fatal("initialization should be cancelled with the caller's ctx")
	}
	if ok.closes.Load() != 0 {
		t.Fatal("a connected client must not be closed")
	}
	if err := s.Connect(context.Background(), ServerConfig{ID: "b", Transport: "http", URL: "http://x"}); err != nil {
		t.Fatal(err)
	}
	if got.InitializationOptions.Signal != nil {
		t.Fatal("a non-cancelable ctx should not be passed as the signal")
	}
}
