package voice

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// 极简 ws 模拟服务器：记录原始请求头行顺序、解掩码客户端帧，按脚本回帧
type mockVolc struct {
	ln      net.Listener
	mu      sync.Mutex
	reqs    [][]string // 每个连接的请求头行（含请求行）
	frames  [][]byte   // 收到的二进制帧 payload
	status  int        // 非 101 时直接回这个 HTTP 状态
	body    string
	onFrame func(c net.Conn, n int, payload []byte)
	logID   string
}

func newMockVolc(t *testing.T) *mockVolc {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	m := &mockVolc{ln: ln, status: 101}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go m.serve(c)
		}
	}()
	return m
}

func (m *mockVolc) url() string {
	return "ws://" + m.ln.Addr().String() + "/api/v3/sauc/bigmodel_async"
}

func srvFrame(op byte, payload []byte) []byte {
	b := []byte{0x80 | op}
	n := len(payload)
	switch {
	case n < 126:
		b = append(b, byte(n))
	case n < 65536:
		b = append(b, 126, byte(n>>8), byte(n))
	default:
		b = append(b, 127)
		b = binary.BigEndian.AppendUint64(b, uint64(n))
	}
	return append(b, payload...)
}

func (m *mockVolc) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	var lines []string
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
		lines = append(lines, l)
		if k, v, ok := strings.Cut(l, ": "); ok && strings.EqualFold(k, "Sec-WebSocket-Key") {
			key = v
		}
	}
	m.mu.Lock()
	m.reqs = append(m.reqs, lines)
	st, body, logID := m.status, m.body, m.logID
	if logID == "" {
		logID = "LOG123"
	}
	m.mu.Unlock()
	if st != 101 {
		io.WriteString(c, "HTTP/1.1 "+itoa(st)+" X\r\nContent-Length: "+itoa(len(body))+"\r\nX-Tt-Logid: LOG123\r\n\r\n"+body)
		return
	}
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+base64.StdEncoding.EncodeToString(h[:])+"\r\nX-Tt-Logid: "+logID+"\r\n\r\n")
	n := 0
	for {
		hd := make([]byte, 2)
		if _, err := io.ReadFull(br, hd); err != nil {
			return
		}
		op := hd[0] & 0xf
		ln := uint64(hd[1] & 0x7f)
		if ln == 126 {
			x := make([]byte, 2)
			io.ReadFull(br, x)
			ln = uint64(binary.BigEndian.Uint16(x))
		} else if ln == 127 {
			x := make([]byte, 8)
			io.ReadFull(br, x)
			ln = binary.BigEndian.Uint64(x)
		}
		mask := make([]byte, 4)
		io.ReadFull(br, mask)
		p := make([]byte, ln)
		if _, err := io.ReadFull(br, p); err != nil {
			return
		}
		for i := range p {
			p[i] ^= mask[i%4]
		}
		if op == 8 {
			c.Write(srvFrame(8, p))
			return
		}
		if op != 2 {
			continue
		}
		m.mu.Lock()
		m.frames = append(m.frames, p)
		f := m.onFrame
		m.mu.Unlock()
		if f != nil {
			f(c, n, p)
		}
		n++
	}
}

func itoa(n int) string    { return strings.TrimSpace(strings.Repeat(" ", 0) + jsonNum(n)) }
func jsonNum(n int) string { b, _ := json.Marshal(n); return string(b) }

func resultFrame(text string, last bool) []byte {
	js, _ := json.Marshal(map[string]any{"result": map[string]any{"text": text}})
	seq := int32(1)
	flags := flagSeq
	if last {
		seq = -1
		flags |= flagLast
	}
	b := []byte{0x11, byte(msgFullServer<<4 | flags), byte(serJSON<<4 | compGzip), 0}
	b = binary.BigEndian.AppendUint32(b, uint32(seq))
	g := gzipSync(js)
	b = binary.BigEndian.AppendUint32(b, uint32(len(g)))
	return append(b, g...)
}

func errorFrame(code uint32, msg string) []byte {
	b := []byte{0x11, byte(msgError << 4), 0, 0}
	b = binary.BigEndian.AppendUint32(b, code)
	b = binary.BigEndian.AppendUint32(b, uint32(len(msg)))
	return append(b, msg...)
}

func zero() *int { z := 0; return &z }

func TestVolcSessionHandshakeAndResult(t *testing.T) {
	m := newMockVolc(t)
	m.onFrame = func(c net.Conn, n int, p []byte) {
		f := int(p[1] & 0xf)
		if p[1]>>4 == msgAudio && f&flagLast != 0 {
			c.Write(srvFrame(2, resultFrame("你好世界", true)))
		} else if p[1]>>4 == msgAudio {
			c.Write(srvFrame(2, resultFrame("你好", false)))
			c.Write(srvFrame(2, resultFrame("你好", false))) // 相同文本不重复推临时结果
		}
	}
	var parts []string
	var pmu sync.Mutex
	s := NewVolcSession(VolcOpts{APIKey: "k-secret", ResourceID: "volc.seedasr.sauc.duration", URL: m.url(), Retries: zero(),
		OnPartial: func(t string) { pmu.Lock(); parts = append(parts, t); pmu.Unlock() }})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	s.Push(make([]byte, 6500))
	time.Sleep(100 * time.Millisecond)
	text, err := s.Finish()
	if err != nil || text != "你好世界" {
		t.Fatalf("finish = %q %v", text, err)
	}
	pmu.Lock()
	if len(parts) != 1 || parts[0] != "你好" {
		t.Fatalf("partials %v", parts)
	}
	pmu.Unlock()
	if id, ok := s.ServerLogID(); !ok || id != "LOG123" {
		t.Fatalf("logid %q %v", id, ok)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// 请求头顺序 = Node ws 8（websocket.js initAsClient）：{...自定义头, Version, Key, Connection, Upgrade}，再加 Extensions，Host 由 http 追加在最后
	var names []string
	for _, l := range m.reqs[0][1:] {
		k, _, _ := strings.Cut(l, ": ")
		names = append(names, k)
	}
	want := "X-Api-Key,X-Api-Resource-Id,X-Api-Request-Id,X-Api-Connect-Id,X-Api-Sequence,Sec-WebSocket-Version,Sec-WebSocket-Key,Connection,Upgrade,Sec-WebSocket-Extensions,Host"
	if strings.Join(names, ",") != want {
		t.Fatalf("header order %s", strings.Join(names, ","))
	}
	for _, l := range m.reqs[0] {
		k, v, _ := strings.Cut(l, ": ")
		want := map[string]string{"X-Api-Key": "k-secret", "X-Api-Resource-Id": "volc.seedasr.sauc.duration", "X-Api-Sequence": "-1",
			"Sec-WebSocket-Version": "13", "Connection": "Upgrade", "Upgrade": "websocket",
			"Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits", "Host": m.ln.Addr().String()}[k]
		if want != "" && v != want {
			t.Fatalf("%s = %q", k, v)
		}
		if k == "X-Api-Request-Id" && v != s.RequestID {
			t.Fatalf("request id %q", v)
		}
	}
	if m.reqs[0][0] != "GET /api/v3/sauc/bigmodel_async HTTP/1.1" {
		t.Fatalf("request line %q", m.reqs[0][0])
	}
	// 帧：full request → 1 个 6400 包 → 最后一包（100 字节）
	if len(m.frames) != 3 {
		t.Fatalf("frames %d", len(m.frames))
	}
	fr := m.frames[0]
	if fr[0] != 0x11 || fr[1] != msgFullClient<<4 || fr[2] != serJSON<<4|compGzip {
		t.Fatalf("full request header % x", fr[:4])
	}
	js, err := gunzipSync(fr[8:])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(js), `{"user":{"uid":`) {
		t.Fatalf("full request json %s", js)
	}
	a1, _ := gunzipSync(m.frames[1][8:])
	a2, _ := gunzipSync(m.frames[2][8:])
	if len(a1) != 6400 || len(a2) != 100 || m.frames[2][1]&0xf != flagLast {
		t.Fatalf("audio %d %d flags %x", len(a1), len(a2), m.frames[2][1])
	}
}

func TestVolcSessionHTTPAuthError(t *testing.T) {
	m := newMockVolc(t)
	m.status, m.body = 401, `{"error":"invalid key k-secret"}`
	s := NewVolcSession(VolcOpts{APIKey: "k-secret", ResourceID: "r", URL: m.url(), Retries: zero()})
	err := s.Start()
	ve, ok := err.(*VolcAsrError)
	if !ok || ve.Kind != "auth" || ve.Status == nil || *ve.Status != 401 || strings.Contains(ve.Message, "k-secret") {
		t.Fatalf("err %#v", err)
	}
	if !strings.HasSuffix(ve.Message, "（HTTP 401）") {
		t.Fatalf("message %q", ve.Message)
	}
}

func TestVolcSessionServerErrorFrame(t *testing.T) {
	m := newMockVolc(t)
	m.onFrame = func(c net.Conn, n int, p []byte) {
		if n == 0 {
			c.Write(srvFrame(2, errorFrame(45000001, "bad request params")))
		}
	}
	s := NewVolcSession(VolcOpts{APIKey: "k", ResourceID: "r", URL: m.url(), Retries: zero()})
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	_, err := s.Finish()
	ve, ok := err.(*VolcAsrError)
	if !ok || ve.Code == nil || *ve.Code != 45000001 || !strings.Contains(ve.Message, "45000001 bad request params") {
		t.Fatalf("err %#v", err)
	}
}

func TestVolcSessionRetryBeforeAudio(t *testing.T) {
	m := newMockVolc(t)
	m.status = 503
	one := 1
	s := NewVolcSession(VolcOpts{APIKey: "k", ResourceID: "r", URL: m.url(), Retries: &one, Backoff: func(int) time.Duration { return time.Millisecond }})
	_ = s.Start()
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.reqs) != 2 {
		t.Fatalf("attempts %d", len(m.reqs))
	}
}
