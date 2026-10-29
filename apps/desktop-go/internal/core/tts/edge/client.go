package edge

import (
	"context"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// ErrorKind = EdgeErrorKind
type ErrorKind string

const (
	KindOffline   ErrorKind = "offline"
	KindTimeout   ErrorKind = "timeout"
	KindForbidden ErrorKind = "forbidden"
	KindProtocol  ErrorKind = "protocol"
	KindAborted   ErrorKind = "aborted"
)

// TtsError = EdgeTtsError
type TtsError struct {
	Kind ErrorKind
	Msg  string
	// Retryable：只用于 403，学到服务器时钟后值得重试一次
	Retryable bool
}

func (e *TtsError) Error() string { return e.Msg }

// Socket 是 ws 客户端的最小面（测试可替换），事件语义同 Node 的 EdgeSocket
type Socket interface {
	// Read 阻塞读一条消息；binary 表示二进制帧
	Read(ctx context.Context) (data []byte, binary bool, err error)
	Send(ctx context.Context, text string) error
	Terminate()
}

// DialError 描述握手失败：Status>0 表示 unexpected-response，否则是 error 事件（Code 为 Node errno 名）
type DialError struct {
	Status int
	Date   string
	Code   string
	Msg    string
}

func (e *DialError) Error() string { return e.Msg }

// SocketFactory = SocketFactory
type SocketFactory func(ctx context.Context, url string, headers Header) (Socket, error)

// HandshakeTimeout = ws 的 handshakeTimeout
var HandshakeTimeout = 10 * time.Second

type wsSocket struct{ c *websocket.Conn }

func (s *wsSocket) Read(ctx context.Context) ([]byte, bool, error) {
	t, b, err := s.c.Read(ctx)
	return b, t == websocket.MessageBinary, err
}
func (s *wsSocket) Send(ctx context.Context, text string) error {
	return s.c.Write(ctx, websocket.MessageText, []byte(text))
}
func (s *wsSocket) Terminate() { _ = s.c.CloseNow() }

// DefaultFactory：coder/websocket，自带头按 Node 顺序写入；permessage-deflate 协商见 D-B9-5
func DefaultFactory(ctx context.Context, url string, headers Header) (Socket, error) {
	h := http.Header{}
	for _, kv := range headers {
		h[kv[0]] = []string{kv[1]}
	}
	hctx, cancel := context.WithTimeout(ctx, HandshakeTimeout)
	defer cancel()
	c, resp, err := websocket.Dial(hctx, url, &websocket.DialOptions{HTTPHeader: h, CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			return nil, &DialError{Status: resp.StatusCode, Date: resp.Header.Get("Date")}
		}
		if ctx.Err() == nil && hctx.Err() != nil {
			return nil, &DialError{Msg: "Opening handshake has timed out"}
		}
		return nil, nodeNetError(err, url)
	}
	c.SetReadLimit(-1)
	return &wsSocket{c}, nil
}

// nodeNetError 把 Go 的网络错误翻成 Node 的 errno 名与 message（`getaddrinfo ENOTFOUND host`、`connect ECONNREFUSED ip:port`）
func nodeNetError(err error, rawURL string) *DialError {
	var dns *net.DNSError
	if errors.As(err, &dns) {
		code := "ENOTFOUND"
		if dns.IsTemporary || dns.IsTimeout {
			code = "EAI_AGAIN"
		}
		return &DialError{Code: code, Msg: "getaddrinfo " + code + " " + dns.Name}
	}
	addr := ""
	var op *net.OpError
	if errors.As(err, &op) && op.Addr != nil {
		addr = " " + op.Addr.String()
	}
	for _, m := range []struct {
		e    syscall.Errno
		code string
		op   string
	}{
		{syscall.ECONNREFUSED, "ECONNREFUSED", "connect"},
		{syscall.ECONNRESET, "ECONNRESET", "read"},
		{syscall.ENETUNREACH, "ENETUNREACH", "connect"},
		{syscall.EHOSTUNREACH, "EHOSTUNREACH", "connect"},
		{syscall.ETIMEDOUT, "ETIMEDOUT", "connect"},
	} {
		if errors.Is(err, m.e) {
			return &DialError{Code: m.code, Msg: m.op + " " + m.code + addr}
		}
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return &DialError{Code: "ETIMEDOUT", Msg: "connect ETIMEDOUT" + addr}
	}
	return &DialError{Msg: err.Error()}
}

// SynthOptions = EdgeSynthOptions
type SynthOptions struct {
	Voice   string
	Rate    float64
	Timeout time.Duration // 0 = 15s
}

// Client = EdgeTtsClient
type Client struct{ CreateSocket SocketFactory }

// NewClient = new EdgeTtsClient(deps)
func NewClient(f SocketFactory) *Client {
	if f == nil {
		f = DefaultFactory
	}
	return &Client{CreateSocket: f}
}

var offlineCodes = regexp.MustCompile(`ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT`)

// Synthesize 合成一段 mp3；403 且学到服务器时钟时重试一次
func (c *Client) Synthesize(ctx context.Context, text string, o SynthOptions) ([]byte, error) {
	if !VoiceNameRe.MatchString(o.Voice) {
		return nil, &TtsError{Kind: KindProtocol, Msg: "invalid voice " + o.Voice}
	}
	b, err := c.attempt(ctx, text, o)
	var te *TtsError
	if errors.As(err, &te) && te.Kind == KindForbidden && te.Retryable {
		return c.attempt(ctx, text, o)
	}
	return b, err
}

func (c *Client) attempt(parent context.Context, text string, o SynthOptions) ([]byte, error) {
	if parent.Err() != nil {
		return nil, &TtsError{Kind: KindAborted, Msg: "aborted"}
	}
	to := o.Timeout
	if to == 0 {
		to = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, to)
	defer cancel()
	classify := func() *TtsError {
		if parent.Err() != nil {
			return &TtsError{Kind: KindAborted, Msg: "aborted"}
		}
		return &TtsError{Kind: KindTimeout, Msg: "edge tts timed out"}
	}
	var (
		mu   sync.Mutex
		sock Socket
	)
	stop := context.AfterFunc(ctx, func() {
		mu.Lock()
		if sock != nil {
			sock.Terminate()
		}
		mu.Unlock()
	})
	defer stop()
	s, err := c.CreateSocket(ctx, SynthesisURL(NowSeconds()), SocketHeaders())
	if err != nil {
		if ctx.Err() != nil {
			return nil, classify()
		}
		var de *DialError
		if errors.As(err, &de) {
			if de.Status == 403 {
				return nil, &TtsError{Kind: KindForbidden, Msg: "edge tts rejected the request (403)", Retryable: AdjustSkewFromServerDate(de.Date)}
			}
			if de.Status > 0 {
				return nil, &TtsError{Kind: KindProtocol, Msg: "unexpected HTTP " + itoa(de.Status)}
			}
			code := de.Code
			if code == "" {
				code = de.Msg
			}
			kind := KindProtocol
			if offlineCodes.MatchString(code) {
				kind = KindOffline
			}
			return nil, &TtsError{Kind: kind, Msg: de.Msg}
		}
		return nil, &TtsError{Kind: KindProtocol, Msg: err.Error()}
	}
	mu.Lock()
	sock = s
	mu.Unlock()
	defer s.Terminate()
	if err := s.Send(ctx, ConfigFrame()); err == nil {
		err = s.Send(ctx, SSMLFrame(text, o.Voice, o.Rate))
		if err != nil && ctx.Err() == nil {
			return nil, &TtsError{Kind: KindProtocol, Msg: err.Error()}
		}
	} else if ctx.Err() == nil {
		return nil, &TtsError{Kind: KindProtocol, Msg: err.Error()}
	}
	var chunks []byte
	n := 0
	for {
		data, bin, err := s.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil, classify()
			}
			// close 事件：有音频就交付，否则 socket closed
			if websocket.CloseStatus(err) != -1 || errors.Is(err, net.ErrClosed) || strings.Contains(err.Error(), "EOF") {
				if n > 0 {
					return chunks, nil
				}
				return nil, &TtsError{Kind: KindProtocol, Msg: "socket closed"}
			}
			if n > 0 {
				return chunks, nil
			}
			return nil, &TtsError{Kind: KindProtocol, Msg: "socket closed"}
		}
		if bin {
			if a := BinaryFrameAudio(data); len(a) > 0 {
				chunks = append(chunks, a...)
				n++
			}
			continue
		}
		if p, _ := TextFramePath(string(data)); p == "turn.end" {
			if n == 0 {
				return nil, &TtsError{Kind: KindProtocol, Msg: "no audio received"}
			}
			return chunks, nil
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}
