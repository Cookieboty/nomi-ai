package voice

// nodews：Node `ws`（8.x）客户端在本项目用到的子集，自写（不引第三方 WebSocket / 厂商 SDK），
// 让握手请求与 `new WebSocket(url, { headers, handshakeTimeout, maxPayload })` 逐字节同形：
//   - 请求行 `GET <pathname+search> HTTP/1.1`，头顺序 = 用户头 → Sec-WebSocket-Version → Sec-WebSocket-Key →
//     Connection → Upgrade → Sec-WebSocket-Extensions（permessage-deflate; client_max_window_bits）→ Host
//     （Node http 最后补 Host，非默认端口才带 `:port`）；
//   - 响应校验与 ws 相同（101 以外 = unexpected-response；Upgrade / Accept / 子协议 / 扩展的错误文本同 ws）；
//   - 协商到 permessage-deflate 时按 ws 默认：≥1024 字节的消息压缩、上下文接管（context takeover），
//     收到的压缩消息解压；服务端把 client_max_window_bits 限到 15 以下时改发不压缩的消息（RFC 7692 允许，
//     ws 的 zlib 会按窗口压，Go flate 只有 32K 窗口：字节不同、语义相同）；
//   - 帧：客户端掩码、自动回 pong、收到 close 回 close；maxPayload 超限按 ws 报 1009。
// TLS 握手由 crypto/tls 完成（ClientHello 与 OpenSSL 不同，D-B9-5 收窄后的剩余差异）。

import (
	"bufio"
	"bytes"
	"compress/flate"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// wsDialContext：建 TCP 连接（测试换成可控的连接）
var wsDialContext = (&net.Dialer{}).DialContext

// WsHeader：有序的请求头（Node 对象字面量的插入顺序）
type WsHeader [][2]string

// WsUnexpected：握手返回非 101（ws 的 'unexpected-response'）
type WsUnexpected struct {
	Status  int
	Headers http.Header
	Body    string
	BodyErr error
}

func (e *WsUnexpected) Error() string { return "Unexpected server response: " + strconv.Itoa(e.Status) }

// WsHooks：ws 的事件（open 之后的 message / close / error 由读循环回调）
type WsHooks struct {
	Upgrade func(h http.Header)
	Message func(data []byte)
	Close   func(code int)
	Error   func(err error)
}

// WsConn：建立好的连接。
//
// 写出（#194）：Send / Close / pong 只把编好的帧放进出站队列，不在调用方的 goroutine 里等网络
// （同 ws：send 写进 socket 缓冲即返回，背压不阻塞调用方）。单个写 goroutine 按入队顺序写出，
// 所以 full request → 音频包 → close 的顺序与 permessage-deflate 上下文（入队时压缩）不变。
// close 帧入队后给剩余写入设截止期，对端停读造成的背压也能在有限时间内解除（写超时 = 断开连接）。
type WsConn struct {
	c       net.Conn
	br      *bufio.Reader
	hooks   WsHooks
	maxPay  int64
	deflate *pmd
	closeMu sync.Mutex
	sentCls bool
	closed  bool
	done    chan struct{}

	qmu      sync.Mutex
	qcond    *sync.Cond
	queue    [][]byte // 待写出的帧（已加掩码）
	qFinal   bool     // close 帧已入队 / 读循环已结束：不再收新帧，写完队列即停
	qStopped bool     // 写 goroutine 已退出（写错误 / 断开）
	wdone    chan struct{}
}

// wsCloseWriteGrace：close 之后剩余帧（含 close 帧）的写截止期；对端停读时到点断开（测试可调）
var wsCloseWriteGrace = 2 * time.Second

// wsCloseTimeout = ws 的 closeTimeout：发出 close 后等对端 close 的时间
var wsCloseTimeout = 30 * time.Second

// nodeNetError：把 Go 的拨号错误写成 Node 的 err.message（`connect ECONNREFUSED 127.0.0.1:1`、
// `getaddrinfo ENOTFOUND host` 等）；其他错误原样
func nodeNetError(err error, host, port string) error {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return errors.New("getaddrinfo ENOTFOUND " + host)
		}
		if dnsErr.IsTimeout {
			return errors.New("getaddrinfo EAI_AGAIN " + host)
		}
		return errors.New("getaddrinfo EAI_AGAIN " + host)
	}
	var op *net.OpError
	addr := net.JoinHostPort(host, port)
	if errors.As(err, &op) && op.Addr != nil {
		addr = op.Addr.String()
	}
	code := ""
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		code = "ECONNREFUSED"
	case errors.Is(err, syscall.ECONNRESET):
		return errors.New("read ECONNRESET")
	case errors.Is(err, syscall.EHOSTUNREACH):
		code = "EHOSTUNREACH"
	case errors.Is(err, syscall.ENETUNREACH):
		code = "ENETUNREACH"
	case errors.Is(err, syscall.ETIMEDOUT):
		code = "ETIMEDOUT"
	case errors.Is(err, syscall.EADDRNOTAVAIL):
		code = "EADDRNOTAVAIL"
	}
	if code != "" {
		return errors.New("connect " + code + " " + addr)
	}
	return err
}

// DialNodeWs = new WebSocket(url, { headers, handshakeTimeout, maxPayload })，同步完成握手。
// 返回 *WsUnexpected 表示非 101 响应（已读完响应体）。ctx 取消 = terminate。
func DialNodeWs(ctx context.Context, rawURL string, headers WsHeader, maxPayload int64, hooks WsHooks) (*WsConn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("Invalid URL: " + rawURL)
	}
	secure := u.Scheme == "wss" || u.Scheme == "https"
	if !secure && u.Scheme != "ws" && u.Scheme != "http" {
		return nil, errors.New(`The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`)
	}
	host := u.Hostname()
	defPort := "80"
	if secure {
		defPort = "443"
	}
	port := u.Port()
	if port == "" {
		port = defPort
	}
	c, err := wsDialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nodeNetError(err, host, port)
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	if secure {
		sn := host
		if net.ParseIP(host) != nil {
			sn = ""
		}
		tc := tls.Client(c, &tls.Config{ServerName: sn, InsecureSkipVerify: false})
		if err := tc.HandshakeContext(ctx); err != nil {
			_ = c.Close()
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		c = tc
	}
	keyRaw := make([]byte, 16)
	_, _ = rand.Read(keyRaw)
	key := base64.StdEncoding.EncodeToString(keyRaw)
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" || u.ForceQuery {
		path += "?" + u.RawQuery
	}
	hostHdr := host
	if strings.Contains(host, ":") {
		hostHdr = "[" + host + "]"
	}
	if port != defPort {
		hostHdr += ":" + port
	}
	var b bytes.Buffer
	b.WriteString("GET " + path + " HTTP/1.1\r\n")
	all := append(WsHeader{}, headers...)
	all = append(all,
		[2]string{"Sec-WebSocket-Version", "13"},
		[2]string{"Sec-WebSocket-Key", key},
		[2]string{"Connection", "Upgrade"},
		[2]string{"Upgrade", "websocket"},
		[2]string{"Sec-WebSocket-Extensions", "permessage-deflate; client_max_window_bits"},
		[2]string{"Host", hostHdr},
	)
	for _, h := range all {
		b.WriteString(h[0] + ": " + h[1] + "\r\n")
	}
	b.WriteString("\r\n")
	if _, err := c.Write(b.Bytes()); err != nil {
		_ = c.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, nodeNetError(err, host, port)
	}
	br := bufio.NewReader(c)
	res, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = c.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("socket hang up")
		}
		return nil, nodeNetError(err, host, port)
	}
	if res.StatusCode != 101 {
		// ws：有 'unexpected-response' 监听时把响应交给调用方；这里读完响应体
		body, berr := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		_ = c.Close()
		return nil, &WsUnexpected{Status: res.StatusCode, Headers: res.Header, Body: string(body), BodyErr: berr}
	}
	if hooks.Upgrade != nil {
		hooks.Upgrade(res.Header)
	}
	fail := func(msg string) (*WsConn, error) { _ = c.Close(); return nil, errors.New(msg) }
	if strings.ToLower(res.Header.Get("Upgrade")) != "websocket" {
		return fail("Invalid Upgrade header")
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	if res.Header.Get("Sec-Websocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		return fail("Invalid Sec-WebSocket-Accept header")
	}
	if _, ok := res.Header["Sec-Websocket-Protocol"]; ok {
		return fail("Server sent a subprotocol but none was requested")
	}
	conn := &WsConn{c: c, br: br, hooks: hooks, maxPay: maxPayload, done: make(chan struct{}), wdone: make(chan struct{})}
	conn.qcond = sync.NewCond(&conn.qmu)
	if ext, ok := res.Header["Sec-Websocket-Extensions"]; ok {
		p, err := parsePMD(strings.Join(ext, ", "))
		if err != nil {
			return fail(err.Error())
		}
		conn.deflate = p
	}
	go conn.writeLoop()
	return conn, nil
}

// pmd：permessage-deflate 的协商结果与上下文
type pmd struct {
	serverNoCtx, clientNoCtx bool
	clientBits               int
	inHist, outHist          []byte
}

// parsePMD = ws extension.parse + PerMessageDeflate.accept（客户端）
func parsePMD(h string) (*pmd, error) {
	invalid := errors.New("Invalid Sec-WebSocket-Extensions header")
	exts := strings.Split(h, ",")
	var p *pmd
	for _, e := range exts {
		parts := strings.Split(e, ";")
		name := strings.TrimSpace(parts[0])
		if name != "permessage-deflate" {
			return nil, errors.New("Server indicated an extension that was not requested")
		}
		if p != nil {
			return nil, invalid
		}
		p = &pmd{clientBits: 15}
		seen := map[string]bool{}
		for _, kv := range parts[1:] {
			k, v, hasV := strings.Cut(strings.TrimSpace(kv), "=")
			k = strings.TrimSpace(k)
			v = strings.Trim(strings.TrimSpace(v), `"`)
			if seen[k] {
				return nil, errors.New(`Parameter "` + k + `" must have only a single value`)
			}
			seen[k] = true
			switch k {
			case "server_no_context_takeover":
				if hasV {
					return nil, errors.New(`Invalid value for parameter "` + k + `": ` + v)
				}
				p.serverNoCtx = true
			case "client_no_context_takeover":
				if hasV {
					return nil, errors.New(`Invalid value for parameter "` + k + `": ` + v)
				}
				p.clientNoCtx = true
			case "server_max_window_bits", "client_max_window_bits":
				n, err := strconv.Atoi(v)
				if !hasV || err != nil || n < 8 || n > 15 {
					return nil, errors.New(`Invalid value for parameter "` + k + `": ` + v)
				}
				if k == "client_max_window_bits" {
					p.clientBits = n
				}
			default:
				return nil, errors.New(`Unknown parameter "` + k + `"`)
			}
		}
	}
	return p, nil
}

func keepTail(h []byte, add []byte) []byte {
	h = append(h, add...)
	if len(h) > 32768 {
		h = append([]byte(nil), h[len(h)-32768:]...)
	}
	return h
}

func (p *pmd) compress(data []byte) []byte {
	var b bytes.Buffer
	var w *flate.Writer
	if p.clientNoCtx || len(p.outHist) == 0 {
		w, _ = flate.NewWriter(&b, flate.DefaultCompression)
	} else {
		w, _ = flate.NewWriterDict(&b, flate.DefaultCompression, p.outHist)
	}
	_, _ = w.Write(data)
	_ = w.Flush()
	out := b.Bytes()
	out = bytes.TrimSuffix(out, []byte{0, 0, 0xff, 0xff})
	if !p.clientNoCtx {
		p.outHist = keepTail(p.outHist, data)
	}
	return out
}

func (p *pmd) decompress(data []byte, max int64) ([]byte, error) {
	in := append(append([]byte(nil), data...), 0, 0, 0xff, 0xff, 1, 0, 0, 0xff, 0xff)
	var r io.ReadCloser
	if p.serverNoCtx || len(p.inHist) == 0 {
		r = flate.NewReader(bytes.NewReader(in))
	} else {
		r = flate.NewReaderDict(bytes.NewReader(in), p.inHist)
	}
	out, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	if max > 0 && int64(len(out)) > max {
		return nil, errMaxPayload
	}
	if !p.serverNoCtx {
		p.inHist = keepTail(p.inHist, out)
	}
	return out, nil
}

var errMaxPayload = errors.New("Max payload size exceeded")

// encodeFrame：客户端帧（FIN、掩码）
func encodeFrame(op byte, rsv1 bool, payload []byte) []byte {
	var h [14]byte
	h[0] = 0x80 | op
	if rsv1 {
		h[0] |= 0x40
	}
	n := 2
	l := len(payload)
	switch {
	case l < 126:
		h[1] = 0x80 | byte(l)
	case l < 65536:
		h[1] = 0x80 | 126
		binary.BigEndian.PutUint16(h[2:], uint16(l))
		n = 4
	default:
		h[1] = 0x80 | 127
		binary.BigEndian.PutUint64(h[2:], uint64(l))
		n = 10
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	copy(h[n:], mask[:])
	n += 4
	buf := make([]byte, n+l)
	copy(buf, h[:n])
	for i := 0; i < l; i++ {
		buf[n+i] = payload[i] ^ mask[i%4]
	}
	return buf
}

var errWsNotWritable = errors.New("WebSocket is not open: readyState 3 (CLOSED)")

// enqueueLocked：须持 qmu；final = 这是最后一帧（close），之后不再收帧
func (w *WsConn) enqueueLocked(frame []byte, final bool) error {
	if w.qFinal || w.qStopped {
		return errWsNotWritable
	}
	w.queue = append(w.queue, frame)
	if final {
		w.finalLocked()
	}
	w.qcond.Signal()
	return nil
}

// finalLocked：须持 qmu；不再收新帧，剩余写入限时（背压时到点写失败并断开）
func (w *WsConn) finalLocked() {
	if w.qFinal {
		return
	}
	w.qFinal = true
	_ = w.c.SetWriteDeadline(time.Now().Add(wsCloseWriteGrace))
	w.qcond.Broadcast()
}

// writeLoop：唯一的写者，按入队顺序写出；写失败即断开（读循环随之结束并回调 Close）
func (w *WsConn) writeLoop() {
	defer close(w.wdone)
	for {
		w.qmu.Lock()
		for len(w.queue) == 0 && !w.qFinal && !w.qStopped {
			w.qcond.Wait()
		}
		if len(w.queue) == 0 || w.qStopped {
			w.qStopped = true
			w.queue = nil
			w.qmu.Unlock()
			return
		}
		f := w.queue[0]
		w.queue[0] = nil
		w.queue = w.queue[1:]
		w.qmu.Unlock()
		if _, err := w.c.Write(f); err != nil {
			w.qmu.Lock()
			w.qStopped = true
			w.queue = nil
			w.qmu.Unlock()
			_ = w.c.Close()
			return
		}
	}
}

// writeFrame：入队一帧（控制帧 / 不压缩的数据帧）
func (w *WsConn) writeFrame(op byte, rsv1 bool, payload []byte) error {
	frame := encodeFrame(op, rsv1, payload)
	w.qmu.Lock()
	defer w.qmu.Unlock()
	return w.enqueueLocked(frame, op == 0x8)
}

// Send = ws.send(buffer)（二进制；协商了压缩且 ≥1024 字节时压缩，同 ws 的 threshold）。
// 只入队、不等网络；写失败经读循环的 close 回调报告（同 ws 的 'error' / 'close'）
func (w *WsConn) Send(data []byte) error {
	w.closeMu.Lock()
	sent := w.sentCls
	w.closeMu.Unlock()
	if sent {
		return errors.New("WebSocket is not open: readyState 2 (CLOSING)")
	}
	w.qmu.Lock()
	defer w.qmu.Unlock()
	if w.deflate != nil && len(data) >= 1024 && w.deflate.clientBits == 15 {
		// 压缩与入队在同一把锁内：上下文接管的历史顺序 = 帧的写出顺序
		if w.qFinal || w.qStopped {
			return errWsNotWritable
		}
		return w.enqueueLocked(encodeFrame(0x2, true, w.deflate.compress(data)), false)
	}
	return w.enqueueLocked(encodeFrame(0x2, false, data), false)
}

// Close = ws.close(code)：close 帧排在已入队的帧之后，不阻塞调用方；
// 同 ws 立即起 closeTimeout（30s）计时，等不到对端的 close 就断开
func (w *WsConn) Close(code int) {
	w.closeMu.Lock()
	if w.sentCls || w.closed {
		w.closeMu.Unlock()
		return
	}
	w.sentCls = true
	w.closeMu.Unlock()
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], uint16(code))
	_ = w.writeFrame(0x8, false, p[:])
	go func() {
		t := time.NewTimer(wsCloseTimeout)
		defer t.Stop()
		select {
		case <-w.done:
		case <-t.C:
			_ = w.c.Close()
		}
	}()
}

// Terminate = ws.terminate()：立即断开，在途写入随之返回错误
func (w *WsConn) Terminate() {
	w.stopWriter()
	_ = w.c.Close()
}

// stopWriter：丢弃未写出的帧，写 goroutine 退出
func (w *WsConn) stopWriter() {
	w.qmu.Lock()
	w.qStopped = true
	w.queue = nil
	w.qcond.Broadcast()
	w.qmu.Unlock()
}

// Run：读循环（ws 的 receiver）；返回时已回调 Close
func (w *WsConn) Run() {
	defer close(w.done)
	code := 1006
	var msg []byte
	var msgOp byte
	var compressed bool
	emitErr := func(err error, c int) {
		if w.hooks.Error != nil {
			w.hooks.Error(err)
		}
		w.Close(c)
	}
loop:
	for {
		var h [2]byte
		if _, err := io.ReadFull(w.br, h[:]); err != nil {
			break
		}
		fin := h[0]&0x80 != 0
		rsv1 := h[0]&0x40 != 0
		op := h[0] & 0x0f
		if h[0]&0x30 != 0 || (rsv1 && (w.deflate == nil || op >= 0x8 || op == 0)) {
			emitErr(errors.New("Invalid WebSocket frame: RSV1 must be clear"), 1002)
			break
		}
		if h[1]&0x80 != 0 {
			emitErr(errors.New("Invalid WebSocket frame: MASK must be clear"), 1002)
			break
		}
		l := int64(h[1] & 0x7f)
		switch l {
		case 126:
			var e [2]byte
			if _, err := io.ReadFull(w.br, e[:]); err != nil {
				break loop
			}
			l = int64(binary.BigEndian.Uint16(e[:]))
		case 127:
			var e [8]byte
			if _, err := io.ReadFull(w.br, e[:]); err != nil {
				break loop
			}
			l = int64(binary.BigEndian.Uint64(e[:]))
		}
		if op < 0x8 && w.maxPay > 0 && int64(len(msg))+l > w.maxPay {
			emitErr(errMaxPayload, 1009)
			break
		}
		payload := make([]byte, l)
		if _, err := io.ReadFull(w.br, payload); err != nil {
			break
		}
		switch op {
		case 0x8:
			code = 1005
			if len(payload) >= 2 {
				code = int(binary.BigEndian.Uint16(payload))
			}
			w.closeMu.Lock()
			sent := w.sentCls
			w.sentCls = true
			w.closeMu.Unlock()
			if !sent {
				_ = w.writeFrame(0x8, false, payload[:min(2, len(payload))])
			}
			break loop
		case 0x9:
			_ = w.writeFrame(0xA, false, payload)
			continue
		case 0xA:
			continue
		case 0x0:
			msg = append(msg, payload...)
		default:
			msg, msgOp, compressed = payload, op, rsv1
		}
		if !fin {
			continue
		}
		data := msg
		msg = nil
		if compressed {
			var err error
			data, err = w.deflate.decompress(data, w.maxPay)
			if err != nil {
				if errors.Is(err, errMaxPayload) {
					emitErr(err, 1009)
				} else {
					emitErr(err, 1007)
				}
				break
			}
		}
		_ = msgOp
		if w.hooks.Message != nil {
			w.hooks.Message(data)
		}
	}
	w.closeMu.Lock()
	w.closed = true
	w.closeMu.Unlock()
	// 先让已入队的帧（如回给对端的 close）限时写完，再断开
	w.qmu.Lock()
	w.finalLocked()
	w.qmu.Unlock()
	<-w.wdone
	_ = w.c.Close()
	if w.hooks.Close != nil {
		w.hooks.Close(code)
	}
}
