package voice

// 对应 apps/desktop-electron/internal/core/src/voice/volcAsr.ts：豆包 / 火山引擎「流式语音识别 2.0」客户端（二进制协议 + 一次识别会话）。
// 会话的事件处理全部在 s.mu 下串行执行（等价 Node 的单线程事件循环），回调 onPartial 也在锁内同步调用。

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	VolcAsrURL      = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
	VolcAsrHost     = "openspeech.bytedance.com"
	VolcPacketBytes = 6400
	msgFullClient   = 0b0001
	msgAudio        = 0b0010
	msgFullServer   = 0b1001
	msgError        = 0b1111
	flagSeq         = 0b0001
	flagLast        = 0b0010
	serNone         = 0b0000
	serJSON         = 0b0001
	compGzip        = 0b0001
	volcMaxPayload  = 4 * 1024 * 1024
)

// RandomUUID = crypto.randomUUID()
func RandomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// gzipSync：zlib 默认级别的 gzip。头部 OS 字节按 zlib（unix=3）；deflate 流由 Go 实现（与 zlib 字节不同，解压后相同）
func gzipSync(b []byte) []byte {
	var out bytes.Buffer
	w := gzip.NewWriter(&out)
	w.OS = 3
	_, _ = w.Write(b)
	_ = w.Close()
	return out.Bytes()
}

func gunzipSync(b []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(r)
}

func EncodeFrame(typ, flags, ser, comp int, payload []byte) []byte {
	out := make([]byte, 8+len(payload))
	out[0] = 0b0001<<4 | 0b0001
	out[1] = byte((typ&0xf)<<4 | flags&0xf)
	out[2] = byte((ser&0xf)<<4 | comp&0xf)
	binary.BigEndian.PutUint32(out[4:], uint32(len(payload)))
	copy(out[8:], payload)
	return out
}

func EncodeFullRequest(body any) []byte {
	return EncodeFrame(msgFullClient, 0, serJSON, compGzip, gzipSync([]byte(util.Stringify(body))))
}

func EncodeAudio(pcm []byte, last bool) []byte {
	f := 0
	if last {
		f = flagLast
	}
	return EncodeFrame(msgAudio, f, serNone, compGzip, gzipSync(pcm))
}

// ServerFrame：Kind = "result" | "error"
type ServerFrame struct {
	Kind    string
	Seq     *int32
	Last    bool
	JSON    any
	Code    uint32
	Message string
}

type VolcProtocolError struct{ Msg string }

func (e *VolcProtocolError) Error() string { return e.Msg }

func frameBody(buf []byte, comp, ser int) (any, error) {
	raw := buf
	if comp == compGzip {
		var err error
		if raw, err = gunzipSync(buf); err != nil {
			return nil, err
		}
	}
	if ser == serJSON {
		return util.Parse(raw)
	}
	return util.FromUnits(util.ToUnits(string(raw))), nil
}

// DecodeServerFrame：格式不对返回 *VolcProtocolError
func DecodeServerFrame(buf []byte) (ServerFrame, error) {
	if len(buf) < 4 {
		return ServerFrame{}, &VolcProtocolError{"frame too short"}
	}
	version := buf[0] >> 4
	headerLen := int(buf[0]&0xf) * 4
	if version != 1 || headerLen < 4 || len(buf) < headerLen {
		return ServerFrame{}, &VolcProtocolError{"bad header"}
	}
	typ := int(buf[1] >> 4)
	flags := int(buf[1] & 0xf)
	ser := int(buf[2] >> 4)
	comp := int(buf[2] & 0xf)
	o := headerLen
	trunc := &VolcProtocolError{"truncated frame"}
	need := func(n int) bool { return len(buf) >= o+n }
	if typ == msgError {
		if !need(8) {
			return ServerFrame{}, trunc
		}
		code := binary.BigEndian.Uint32(buf[o:])
		size := int(binary.BigEndian.Uint32(buf[o+4:]))
		o += 8
		if !need(size) {
			return ServerFrame{}, trunc
		}
		payload := buf[o : o+size]
		var message string
		v, err := frameBody(payload, comp, ser)
		if err != nil {
			message = string(bytes.ToValidUTF8(payload, []byte("\uFFFD")))
		} else if s, ok := v.(string); ok {
			message = s
		} else {
			var pick any
			if ob := util.AsObj(v); ob != nil {
				if e, ok := ob.Lookup("error"); ok && e != nil {
					pick = e
				} else if m, ok := ob.Lookup("message"); ok && m != nil {
					pick = m
				}
			}
			if pick == nil {
				pick = util.Stringify(v)
			}
			message = util.JSString(pick)
		}
		return ServerFrame{Kind: "error", Code: code, Message: message}, nil
	}
	if typ != msgFullServer {
		return ServerFrame{}, &VolcProtocolError{fmt.Sprintf("unexpected message type %d", typ)}
	}
	var seq *int32
	if flags&flagSeq != 0 {
		if !need(4) {
			return ServerFrame{}, trunc
		}
		v := int32(binary.BigEndian.Uint32(buf[o:]))
		seq = &v
		o += 4
	}
	if !need(4) {
		return ServerFrame{}, trunc
	}
	size := int(binary.BigEndian.Uint32(buf[o:]))
	o += 4
	if !need(size) {
		return ServerFrame{}, trunc
	}
	var js any
	if size > 0 {
		v, err := frameBody(buf[o:o+size], comp, ser)
		if err != nil {
			return ServerFrame{}, &VolcProtocolError{"bad payload"}
		}
		js = v
	}
	return ServerFrame{Kind: "result", Seq: seq, Last: flags&flagLast != 0 || (seq != nil && *seq < 0), JSON: js}, nil
}

// ResultText：从响应 JSON 取全量文本
func ResultText(js any) string {
	var r any
	if ob := util.AsObj(js); ob != nil {
		r, _ = ob.Lookup("result")
	}
	one := func(x any) string {
		ob := util.AsObj(x)
		if ob == nil {
			return ""
		}
		if t, ok := ob.Lookup("text"); ok {
			if s, ok := t.(string); ok {
				return s
			}
		}
		if us, ok := ob.Lookup("utterances"); ok {
			if arr, ok := us.([]any); ok {
				var b strings.Builder
				for _, u := range arr {
					var tv any
					if uo := util.AsObj(u); uo != nil {
						tv, _ = uo.Lookup("text")
					}
					if tv == nil {
						tv = ""
					}
					b.WriteString(util.JSString(tv))
				}
				return b.String()
			}
		}
		return ""
	}
	var s string
	if arr, ok := r.([]any); ok {
		var b strings.Builder
		for _, x := range arr {
			b.WriteString(one(x))
		}
		s = b.String()
	} else {
		s = one(r)
	}
	return util.JSTrim(s)
}

// VolcAsrError
type VolcAsrError struct {
	Kind      string
	Message   string
	Code      *uint32
	Status    *int
	LogID     string
	Retryable bool
}

func (e *VolcAsrError) Error() string { return e.Message }

var (
	quotaRE = util.CompileJSI(`quota|exceed|insufficient|balance|arrear|余额|欠费|额度|用量`)
	grantRE = util.CompileJSI(`not\s*grant|not\s*activ|unauthori[sz]ed\s*resource|resource.*(not|invalid)|未开通|未授权|无权限`)
	limitRE = util.CompileJSI(`rate\s*limit|too\s*many|qps|concurren|限流|并发`)
	authRE  = util.CompileJSI(`auth|api[\s_-]*key|token|unauthori[sz]ed|forbidden|鉴权`)
	auth403 = util.CompileJSI(`api[\s_-]*key|invalid|auth`)
)

var volcMsgKeys = map[string]string{
	"auth":        "electron.common.the-doubao-api-key-is-invalid-or-has",
	"not_granted": "electron.common.this-api-key-doesn-t-have-the-selected",
	"quota":       "electron.common.doubao-speech-recognition-quota-is-used-up-or",
	"rate_limit":  "electron.common.too-many-requests-or-the-concurrency-limit-was",
	"busy":        "electron.common.doubao-speech-recognition-is-busy-try-again-later",
	"timeout":     "electron.common.doubao-speech-recognition-timed-out-check-your-network",
	"network":     "electron.common.couldn-t-connect-to-doubao-speech-recognition-check",
	"protocol":    "electron.common.doubao-speech-recognition-returned-data-that-couldn-t",
	"empty":       "electron.common.no-valid-audio-was-received",
	"bad_audio":   "electron.common.doubao-speech-recognition-doesn-t-accept-this-audio",
	"invalid":     "electron.common.invalid-doubao-speech-recognition-request-parameters",
	"server":      "electron.common.doubao-speech-recognition-service-error",
	"cancelled":   "electron.common.cancelled",
}

func volcMessageFor(t func(string) string, kind, extra string) string {
	m := t(volcMsgKeys[kind])
	if extra != "" {
		return m + "（" + extra + "）"
	}
	return m
}

func MapServerError(code uint32, message string) string {
	switch code {
	case 45000002:
		return "empty"
	case 45000081:
		return "timeout"
	case 45000151:
		return "bad_audio"
	case 55000031:
		return "busy"
	}
	switch {
	case quotaRE.Test(message):
		return "quota"
	case grantRE.Test(message):
		return "not_granted"
	case limitRE.Test(message):
		return "rate_limit"
	case authRE.Test(message):
		return "auth"
	}
	if code == 45000001 || (code >= 45000000 && code < 46000000) {
		return "invalid"
	}
	return "server"
}

func MapHTTPError(status int, body string) string {
	switch {
	case quotaRE.Test(body):
		return "quota"
	case grantRE.Test(body):
		return "not_granted"
	case status == 401:
		return "auth"
	case status == 403:
		if auth403.Test(body) {
			return "auth"
		}
		return "not_granted"
	case status == 429:
		return "rate_limit"
	case status == 402:
		return "quota"
	case status >= 500:
		return "server"
	}
	return "invalid"
}

var volcRetryable = map[string]bool{"network": true, "busy": true, "rate_limit": true, "server": true}

// VolcOpts = VolcSessionOptions（毫秒；0 = 默认）
type VolcOpts struct {
	APIKey          string
	ResourceID      string
	URL             string
	ConnectTimeout  time.Duration
	FinalTimeout    time.Duration
	IdleTimeout     time.Duration
	Retries         *int
	Backoff         func(attempt int) time.Duration
	OnPartial       func(text string)
	MayUpload       func() bool
	EnableNonstream bool
	UID             string
	T               func(string) string
}

type volcResult struct {
	text string
	err  error
}

type VolcSession struct {
	o         VolcOpts
	mu        sync.Mutex
	ws        *WsConn
	wsAbort   func() // 建连中的连接：terminate
	state     string // idle | connecting | open | finishing | done
	pending   [][]byte
	carry     []byte
	sentAudio bool
	text      string
	lastPart  string
	logID     string
	hasLogID  bool
	idleGen   int
	finalGen  int
	settle    chan volcResult
	failure   *VolcAsrError
	startOnce sync.Once
	startDone chan struct{}
	startErr  error
	RequestID string
	wsTok     *int
}

func NewVolcSession(o VolcOpts) *VolcSession {
	if o.T == nil {
		o.T = func(k string) string { return k }
	}
	return &VolcSession{o: o, state: "idle", RequestID: RandomUUID()}
}

func (s *VolcSession) mf(kind, extra string) string { return volcMessageFor(s.o.T, kind, extra) }
func (s *VolcSession) verr(kind, extra string) *VolcAsrError {
	return &VolcAsrError{Kind: kind, Message: s.mf(kind, extra)}
}

func (s *VolcSession) AudioSent() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.sentAudio }
func (s *VolcSession) Err() *VolcAsrError {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failure
}
func (s *VolcSession) ServerLogID() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logID, s.hasLogID
}

// Start：建连并发送 full client request（同一个 promise）
func (s *VolcSession) Start() error {
	s.startOnce.Do(func() {
		s.startDone = make(chan struct{})
		go func() {
			s.startErr = s.connectWithRetry()
			close(s.startDone)
		}()
	})
	<-s.startDone
	return s.startErr
}

// StartAsync = void start()
func (s *VolcSession) StartAsync() { go func() { _ = s.Start() }() }

func (s *VolcSession) connectWithRetry() error {
	max := 2
	if s.o.Retries != nil {
		max = int(math.Max(0, float64(*s.o.Retries)))
	}
	for attempt := 0; ; attempt++ {
		e := s.connectOnce()
		if e == nil {
			return nil
		}
		var err *VolcAsrError
		if !errors.As(e, &err) {
			err = s.verr("network", "")
		}
		s.mu.Lock()
		if s.state == "done" || err.Kind == "cancelled" {
			s.mu.Unlock()
			return err
		}
		if !volcRetryable[err.Kind] || attempt >= max || s.sentAudio {
			s.fail(err)
			s.mu.Unlock()
			return err
		}
		s.mu.Unlock()
		d := time.Duration(400*math.Pow(3, float64(attempt))) * time.Millisecond
		if s.o.Backoff != nil {
			d = s.o.Backoff(attempt)
		}
		time.Sleep(d)
		s.mu.Lock()
		if s.state == "done" {
			f := s.failure
			s.mu.Unlock()
			if f != nil {
				return f
			}
			return s.verr("cancelled", "")
		}
		s.mu.Unlock()
	}
}

func (s *VolcSession) scrub(m string) string {
	if s.o.APIKey == "" {
		return m
	}
	return strings.ReplaceAll(m, s.o.APIKey, "••••")
}

func slice120(m string) string { return util.UTF16Slice0(m, 120) }

func (s *VolcSession) connectOnce() error {
	s.mu.Lock()
	if s.state == "done" {
		f := s.failure
		s.mu.Unlock()
		if f != nil {
			return f
		}
		return s.verr("cancelled", "")
	}
	s.state = "connecting"
	headers := WsHeader{
		{"X-Api-Key", s.o.APIKey},
		{"X-Api-Resource-Id", s.o.ResourceID},
		{"X-Api-Request-Id", s.RequestID},
		{"X-Api-Connect-Id", RandomUUID()},
		{"X-Api-Sequence", "-1"},
	}
	timeout := s.o.ConnectTimeout
	if timeout == 0 {
		timeout = 8000 * time.Millisecond
	}
	u := s.o.URL
	if u == "" {
		u = VolcAsrURL
	}
	ctx, cancel := context.WithCancel(context.Background())
	settled := false
	res := make(chan error, 1)
	done := func(err error) { // 锁内调用
		if settled {
			return
		}
		settled = true
		res <- err
	}
	var conn *WsConn
	s.wsAbort = cancel
	timer := time.AfterFunc(timeout, func() {
		s.mu.Lock()
		done(&VolcAsrError{Kind: "timeout", Message: s.mf("timeout", ""), Retryable: true})
		s.mu.Unlock()
		cancel()
	})
	// 当前连接对象 = 本次 dial（用 token 区分「this.ws === ws」）
	tok := new(int)
	s.wsTok = tok
	s.mu.Unlock()

	hooks := WsHooks{
		Upgrade: func(h http.Header) {
			if v, ok := h["X-Tt-Logid"]; ok && len(v) > 0 {
				s.mu.Lock()
				s.logID, s.hasLogID = strings.Join(v, ", "), true
				s.mu.Unlock()
			}
		},
	}
	hooks.Message = func(data []byte) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.wsTok == tok {
			s.onMessage(data)
		}
	}
	hooks.Error = func(e error) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.wsTok != tok {
			return
		}
		s.fail(s.verr("network", slice120(s.scrub(e.Error()))))
	}
	hooks.Close = func(code int) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.wsTok != tok {
			return
		}
		if s.state != "done" {
			s.fail(s.verr("network", s.o.T("electron.common.connection-closed")))
		}
	}
	c, err := DialNodeWs(ctx, u, headers, volcMaxPayload, hooks)
	timer.Stop()
	s.mu.Lock()
	if err != nil {
		var ue *WsUnexpected
		switch {
		case errors.As(err, &ue):
			if v, ok := ue.Headers["X-Tt-Logid"]; ok && len(v) > 0 {
				s.logID, s.hasLogID = strings.Join(v, ", "), true
			}
			if ue.BodyErr != nil {
				k := MapHTTPError(ue.Status, "")
				st := ue.Status
				done(&VolcAsrError{Kind: k, Message: s.mf(k, fmt.Sprintf("HTTP %d", ue.Status)), Status: &st})
			} else {
				text := ue.Body
				k := MapHTTPError(ue.Status, text)
				st := ue.Status
				ve := &VolcAsrError{Kind: k, Message: s.mf(k, fmt.Sprintf("HTTP %d", ue.Status)), Status: &st}
				if s.hasLogID {
					ve.LogID = s.logID
				}
				done(ve)
			}
		case s.state == "done":
			done(s.verr("cancelled", ""))
		default:
			done(s.verr("network", slice120(s.scrub(err.Error()))))
		}
		if s.wsTok == tok {
			s.wsTok = nil
		}
		s.wsAbort = nil
		s.mu.Unlock()
		cancel()
		return <-res
	}
	conn = c
	s.wsAbort = nil
	if settled { // 超时已放弃
		if s.wsTok == tok {
			s.wsTok = nil
		}
		s.mu.Unlock()
		conn.Terminate()
		go conn.Run()
		cancel()
		return <-res
	}
	go conn.Run()
	if s.state == "done" {
		conn.Close(1000)
		done(s.verr("cancelled", ""))
		s.wsTok = nil
		s.mu.Unlock()
		cancel()
		return <-res
	}
	s.ws = conn
	s.state = "open"
	req := util.NewObj("model_name", "bigmodel", "enable_itn", true, "enable_punc", true,
		"show_utterances", true, "result_type", "full")
	if s.o.EnableNonstream {
		req.Set("enable_nonstream", true)
	}
	uid := s.o.UID
	if uid == "" {
		uid = "nomi-desktop"
	}
	_ = conn.Send(EncodeFullRequest(util.NewObj(
		"user", util.NewObj("uid", uid),
		"audio", util.NewObj("format", "pcm", "codec", "raw", "rate", 16000.0, "bits", 16.0, "channel", 1.0),
		"request", req,
	)))
	done(nil)
	s.flush()
	s.mu.Unlock()
	cancel()
	return <-res
}

func (s *VolcSession) onMessage(data []byte) {
	if s.state == "done" {
		return
	}
	f, err := DecodeServerFrame(data)
	if err != nil {
		s.fail(s.verr("protocol", ""))
		return
	}
	if f.Kind == "error" {
		kind := MapServerError(f.Code, f.Message)
		code := f.Code
		ve := &VolcAsrError{Kind: kind, Message: s.mf(kind, util.JSTrim(fmt.Sprintf("%d %s", f.Code, slice120(s.scrub(f.Message))))), Code: &code}
		if s.hasLogID {
			ve.LogID = s.logID
		}
		s.fail(ve)
		return
	}
	text := ResultText(f.JSON)
	if f.JSON != nil {
		s.text = text
	}
	if f.Last {
		s.complete()
		return
	}
	if s.text != s.lastPart {
		s.lastPart = s.text
		if s.o.OnPartial != nil {
			s.o.OnPartial(s.text)
		}
	}
}

// Push：推一段 PCM16，内部按 200ms 分包
func (s *VolcSession) Push(pcm []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == "done" || s.state == "finishing" {
		return
	}
	s.armIdle()
	buf := append(append([]byte(nil), s.carry...), pcm...)
	for len(buf) >= VolcPacketBytes {
		s.pending = append(s.pending, EncodeAudio(buf[:VolcPacketBytes], false))
		buf = buf[VolcPacketBytes:]
	}
	s.carry = append([]byte(nil), buf...)
	s.flush()
}

func (s *VolcSession) flush() {
	if s.state != "open" && s.state != "finishing" {
		return
	}
	ws := s.ws
	if ws == nil || len(s.pending) == 0 {
		return
	}
	if s.o.MayUpload != nil && !s.o.MayUpload() {
		s.cancelLocked()
		return
	}
	for len(s.pending) > 0 {
		p := s.pending[0]
		s.pending = s.pending[1:]
		s.sentAudio = true
		_ = ws.Send(p)
	}
}

func (s *VolcSession) armIdle() {
	s.idleGen++
	g := s.idleGen
	ms := s.o.IdleTimeout
	if ms == 0 {
		ms = 15000 * time.Millisecond
	}
	time.AfterFunc(ms, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.idleGen == g {
			s.fail(s.verr("timeout", ""))
		}
	})
}

// Finish：发送最后一包并等最终结果
func (s *VolcSession) Finish() (string, error) {
	s.mu.Lock()
	if s.failure != nil {
		f := s.failure
		s.mu.Unlock()
		return "", f
	}
	if s.state == "done" {
		t := s.text
		s.mu.Unlock()
		return t, nil
	}
	s.idleGen++
	s.pending = append(s.pending, EncodeAudio(s.carry, true))
	s.carry = nil
	s.mu.Unlock()
	if err := s.Start(); err != nil {
		return "", err
	}
	s.mu.Lock()
	if s.failure != nil {
		f := s.failure
		s.mu.Unlock()
		return "", f
	}
	if s.state == "done" {
		t := s.text
		s.mu.Unlock()
		return t, nil
	}
	s.state = "finishing"
	ch := make(chan volcResult, 1)
	s.settle = ch
	s.finalGen++
	g := s.finalGen
	ft := s.o.FinalTimeout
	if ft == 0 {
		ft = 10000 * time.Millisecond
	}
	time.AfterFunc(ft, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.finalGen == g {
			s.fail(s.verr("timeout", ""))
		}
	})
	s.flush()
	s.mu.Unlock()
	r := <-ch
	return r.text, r.err
}

func (s *VolcSession) complete() {
	st := s.settle
	s.teardown(1000)
	if st != nil {
		st <- volcResult{text: s.text}
	}
}

func (s *VolcSession) fail(err *VolcAsrError) {
	if s.state == "done" {
		return
	}
	s.failure = err
	st := s.settle
	s.teardown(1011)
	if st != nil {
		st <- volcResult{err: err}
	}
}

// Cancel：取消并丢弃
func (s *VolcSession) Cancel() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancelLocked()
}

func (s *VolcSession) cancelLocked() {
	if s.state == "done" {
		return
	}
	s.failure = s.verr("cancelled", "")
	st := s.settle
	s.teardown(1000)
	if st != nil {
		st <- volcResult{err: s.failure}
	}
}

func (s *VolcSession) teardown(code int) {
	s.state = "done"
	s.settle = nil
	s.pending = nil
	s.carry = nil
	s.idleGen++
	s.finalGen++
	ws := s.ws
	s.ws = nil
	s.wsTok = nil
	if ws != nil {
		ws.Close(code)
	} else if s.wsAbort != nil {
		// 建连中：ws.close() → abortHandshake → 'error'（state=done → cancelled）
		s.wsAbort()
	}
}

// ProbeVolc：只建连并发送参数包，等 wait 看有没有错误帧
func ProbeVolc(o VolcOpts, wait time.Duration) (logID string, has bool, err error) {
	zero := 0
	o.Retries = &zero
	s := NewVolcSession(o)
	if err := s.Start(); err != nil {
		return "", false, err
	}
	if wait == 0 {
		wait = 1500 * time.Millisecond
	}
	time.Sleep(wait)
	e := s.Err()
	logID, has = s.ServerLogID()
	s.Cancel()
	if e != nil && e.Kind != "cancelled" {
		return "", false, e
	}
	return logID, has, nil
}
