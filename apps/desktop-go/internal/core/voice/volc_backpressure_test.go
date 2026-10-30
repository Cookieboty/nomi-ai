package voice

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stallPeer：net.Pipe 上的模拟服务端。握手并读完 full request 之后停止读取（对端应用不消费），
// 客户端的下一次 Write 就确定地阻塞住 —— 不依赖系统 socket 缓冲大小。
type stallPeer struct {
	srv    net.Conn
	closed chan struct{} // 客户端关闭了连接
}

// trackConn：记录客户端一侧的 Close（服务端停读，不能靠读 EOF 判断）
type trackConn struct {
	net.Conn
	once   sync.Once
	closed chan struct{}
}

func (c *trackConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

func withStallPeer(t *testing.T) *stallPeer {
	t.Helper()
	p := &stallPeer{closed: make(chan struct{})}
	orig, origGrace := wsDialContext, wsCloseWriteGrace
	wsCloseWriteGrace = 100 * time.Millisecond
	t.Cleanup(func() { wsDialContext, wsCloseWriteGrace = orig, origGrace })
	wsDialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		cli, srv := net.Pipe()
		p.srv = srv
		go p.serve()
		return &trackConn{Conn: cli, closed: p.closed}, nil
	}
	t.Cleanup(func() {
		if p.srv != nil {
			_ = p.srv.Close()
		}
	})
	return p
}

func (p *stallPeer) serve() {
	br := bufio.NewReader(p.srv)
	key := ""
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			return
		}
		l = strings.TrimRight(l, "\r\n")
		if l == "" {
			break
		}
		if k, v, ok := strings.Cut(l, ": "); ok && strings.EqualFold(k, "Sec-WebSocket-Key") {
			key = v
		}
	}
	h := sha1.Sum([]byte(key + wsGUID))
	_, _ = io.WriteString(p.srv, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Accept: "+base64.StdEncoding.EncodeToString(h[:])+"\r\n\r\n")
	// 读完第一帧（full client request）
	hd := make([]byte, 2)
	if _, err := io.ReadFull(br, hd); err != nil {
		return
	}
	n := uint64(hd[1] & 0x7f)
	switch n {
	case 126:
		x := make([]byte, 2)
		_, _ = io.ReadFull(br, x)
		n = uint64(binary.BigEndian.Uint16(x))
	case 127:
		x := make([]byte, 8)
		_, _ = io.ReadFull(br, x)
		n = binary.BigEndian.Uint64(x)
	}
	if _, err := io.ReadFull(br, make([]byte, 4+n)); err != nil {
		return
	}
	// 之后不再读取：客户端的下一次 Write 阻塞（net.Pipe 无缓冲）
}

func within(t *testing.T, what string, d time.Duration, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { f(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("%s blocked for %v (session lock held across a stalled network write?)", what, d)
	}
}

func stallSession(t *testing.T, o VolcOpts) *VolcSession {
	t.Helper()
	o.APIKey, o.ResourceID, o.URL, o.Retries = "k", "r", "ws://volc.test/api", zero()
	s := NewVolcSession(o)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	return s
}

// #194：对端停读、写入阻塞时，Push 不再卡住；取消立即完成，连接在写截止期内被关闭、在途写解除，只终结一次
func TestVolcCancelDuringStalledWrite(t *testing.T) {
	p := withStallPeer(t)
	s := stallSession(t, VolcOpts{})
	// 第一包音频：写 goroutine 阻塞在 Write 上（pipe 没人读）
	within(t, "Push", time.Second, func() { s.Push(make([]byte, VolcPacketBytes)) })
	within(t, "Push (2nd)", time.Second, func() { s.Push(make([]byte, VolcPacketBytes)) })
	within(t, "Cancel", time.Second, func() { s.Cancel() })
	if e := s.Err(); e == nil || e.Kind != "cancelled" {
		t.Fatalf("err = %#v", e)
	}
	select {
	case <-p.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed after cancel (stalled write never released)")
	}
	// 重复取消、取消后再推音频：无副作用
	within(t, "Cancel (again)", time.Second, func() { s.Cancel() })
	within(t, "Push after cancel", time.Second, func() { s.Push(make([]byte, VolcPacketBytes)) })
	if e := s.Err(); e == nil || e.Kind != "cancelled" {
		t.Fatalf("err after repeat = %#v", e)
	}
	if _, err := s.Finish(); err == nil {
		t.Fatal("Finish after cancel succeeded")
	}
}

// 最终结果截止期：写入阻塞时 Finish 也按 FinalTimeout 返回超时，并断开连接
func TestVolcFinalTimeoutDuringStalledWrite(t *testing.T) {
	p := withStallPeer(t)
	s := stallSession(t, VolcOpts{FinalTimeout: 100 * time.Millisecond})
	within(t, "Push", time.Second, func() { s.Push(make([]byte, VolcPacketBytes)) })
	var err error
	within(t, "Finish", 2*time.Second, func() { _, err = s.Finish() })
	var ve *VolcAsrError
	if !errors.As(err, &ve) || ve.Kind != "timeout" {
		t.Fatalf("Finish err = %#v", err)
	}
	select {
	case <-p.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed after final timeout")
	}
}

// 空闲截止期 + 上传许可撤回：同样不被阻塞的写卡住，且之后不再入队音频
func TestVolcIdleTimeoutAndRevokeDuringStalledWrite(t *testing.T) {
	p := withStallPeer(t)
	s := stallSession(t, VolcOpts{IdleTimeout: 100 * time.Millisecond})
	within(t, "Push", time.Second, func() { s.Push(make([]byte, VolcPacketBytes)) })
	deadline := time.Now().Add(2 * time.Second)
	for s.Err() == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if e := s.Err(); e == nil || e.Kind != "timeout" {
		t.Fatalf("idle err = %#v", e)
	}
	select {
	case <-p.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed after idle timeout")
	}

	var allowed atomic.Bool
	allowed.Store(true)
	p2 := withStallPeer(t)
	s2 := stallSession(t, VolcOpts{MayUpload: allowed.Load})
	within(t, "Push", time.Second, func() { s2.Push(make([]byte, VolcPacketBytes)) })
	allowed.Store(false)
	within(t, "Push (revoked)", time.Second, func() { s2.Push(make([]byte, VolcPacketBytes)) })
	if e := s2.Err(); e == nil || e.Kind != "cancelled" {
		t.Fatalf("revoked err = %#v", e)
	}
	select {
	case <-p2.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed after upload revoked")
	}
}
