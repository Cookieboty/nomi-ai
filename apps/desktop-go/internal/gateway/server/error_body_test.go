package server

// #427：上游报错后，读取错误正文不得阻塞回退。这些测试只用假 FetchImpl / 假正文，
// 不起真实连接，也没有网络访问。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// testErrorBodyCfg：两家供应商 pa / pb，同一模型 m1，首选 pa；端口只用来过 Host 校验。
func testErrorBodyCfg(t *testing.T) *config.GatewayConfig {
	t.Helper()
	mk := func(id, name string) *u.Obj {
		return u.NewObj("id", id, "name", name, "enabled", true,
			"urls", u.NewObj("chat", "https://"+id+".example.invalid/v1"),
			"keys", []any{u.NewObj("id", "k"+id, "value", "key-"+id, "enabled", true)},
			"models", []any{u.NewObj("id", "m1", "enabled", true)})
	}
	root := u.NewObj(
		"host", "127.0.0.1", "port", 18721.0, "failoverEnabled", true,
		"providers", []any{mk("pa", "PA"), mk("pb", "PB")},
		"clients", u.NewObj("dsh", u.NewObj("token", "tok-dsh", "models", u.NewObj("main", "pa/m1"))),
		"allowedPrivateHosts", []any{},
	)
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(root)), &cfg); err != nil {
		t.Fatalf("config: %v", err)
	}
	return &cfg
}

func errorBodyHooks(t *testing.T, fetch func(*http.Request) (*http.Response, error)) GatewayHooks {
	t.Helper()
	retryBase := 0.0
	return GatewayHooks{FetchImpl: fetch, TimeoutHooks: upstream.TimeoutHooks{RetryBaseDelayMs: &retryBase}}
}

func sendChat(g *GatewayServer) *httptest.ResponseRecorder {
	body := `{"model":"pa/m1","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "http://127.0.0.1:18721/v1/chat/completions", bytes.NewReader([]byte(body)))
	req.Host = "127.0.0.1:18721"
	req.RequestURI = "/v1/chat/completions"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer tok-dsh")
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	return rec
}

const chatOK = `{"id":"c1","object":"chat.completion","created":1,"model":"m1",` +
	`"choices":[{"index":0,"message":{"role":"assistant","content":"from-pb"},"finish_reason":"stop"}],` +
	`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`

func errResponse(req *http.Request, status int, body io.ReadCloser) *http.Response {
	return &http.Response{StatusCode: status, Status: http.StatusText(status),
		Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body, Request: req}
}

// blockingBody：第一次 Next 返回一段前缀，之后一直阻塞到被 Close；记录 Close 次数。
type blockingBody struct {
	mu      sync.Mutex
	prefix  []byte
	sent    bool
	closes  atomic.Int32
	release chan struct{}
}

func newBlockingBody(prefix string) *blockingBody {
	return &blockingBody{prefix: []byte(prefix), release: make(chan struct{})}
}

func (b *blockingBody) Next() ([]byte, error) {
	b.mu.Lock()
	if !b.sent {
		b.sent = true
		p := b.prefix
		b.mu.Unlock()
		return p, nil
	}
	b.mu.Unlock()
	<-b.release
	return nil, errors.New("closed")
}

func (b *blockingBody) Close() error {
	b.closes.Add(1)
	select {
	case <-b.release:
	default:
		close(b.release)
	}
	return nil
}

func TestReadErrorBodyStopsAtReadCap(t *testing.T) {
	huge := strings.Repeat("x", 200*1024)
	body := &memChunks{chunks: [][]byte{[]byte(huge)}}
	start := time.Now()
	text, stop := readErrorBody(context.Background(), body, NowMs()+60_000)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("size cap did not stop the read, took %v", elapsed)
	}
	if stop != errBodyTooLarge || len(text) != ErrorBodyMaxBytes {
		t.Fatalf("expected too-large stop with %d bytes, got stop=%v len=%d", ErrorBodyMaxBytes, stop, len(text))
	}
	if !body.closed {
		t.Fatal("body not closed after hitting the size cap")
	}
}

func TestReadErrorBodyStopsAtDeadline(t *testing.T) {
	blocked := newBlockingBody(`{"error":"slow"`)
	start := time.Now()
	text, stop := readErrorBody(context.Background(), blocked, NowMs()+50)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("deadline not honored, took %v", elapsed)
	}
	if stop != errBodyTimeout || text != `{"error":"slow"` {
		t.Fatalf("expected timeout with prefix kept, got stop=%v text=%q", stop, text)
	}
	if blocked.closes.Load() == 0 {
		t.Fatal("timed-out body was not closed")
	}
}

func TestReadErrorBodyRespectsContextCancel(t *testing.T) {
	blocked := newBlockingBody("")
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	start := time.Now()
	_, stop := readErrorBody(ctx, blocked, NowMs()+60_000)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("cancel not honored, took %v", elapsed)
	}
	if stop != errBodyTimeout || blocked.closes.Load() == 0 {
		t.Fatalf("expected cancel to stop and close, got stop=%v closes=%d", stop, blocked.closes.Load())
	}
}

// memChunks：一次性可读完的内存正文，记录 Close。
type memChunks struct {
	chunks [][]byte
	closed bool
}

func (m *memChunks) Next() ([]byte, error) {
	if len(m.chunks) == 0 {
		return nil, io.EOF
	}
	c := m.chunks[0]
	m.chunks = m.chunks[1:]
	return c, nil
}
func (m *memChunks) Close() error { m.closed = true; return nil }

// 核心：首字节定时器早已停了，错误正文一直不来 —— 后备供应商仍然在读取上限内接手。
func TestErrorBodyStallStillFailsOver(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	blocked := newBlockingBody(`{"error":{"message":"pa overloaded`)
	g := CreateGateway(testErrorBodyCfg(t), errorBodyHooks(t, func(req *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasPrefix(req.URL.Host, "pa."):
			hits["pa"]++
			// pa 的 ctx 被取消（客户端取消 / 网关放弃这次尝试）时正文也结束
			body := &ctxBody{b: blocked, ctx: req.Context()}
			return errResponse(req, 503, body), nil
		case strings.HasPrefix(req.URL.Host, "pb."):
			hits["pb"]++
			return errResponse(req, 200, io.NopCloser(strings.NewReader(chatOK))), nil
		}
		return nil, errors.New("unexpected host")
	}))
	defer g.Stop()

	start := time.Now()
	rec := sendChat(g)
	elapsed := time.Since(start)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "from-pb") {
		t.Fatalf("expected failover to pb, got %d body=%s", rec.Code, rec.Body.String())
	}
	if limit := time.Duration(ErrorBodyIdleMs+3_000) * time.Millisecond; elapsed > limit {
		t.Fatalf("error body stall held failover for %v", elapsed)
	}
	mu.Lock()
	pa, pb := hits["pa"], hits["pb"]
	mu.Unlock()
	// pa 原地重连（瞬时错误）可以再打一次 pa，但绝不能一直等正文
	if pa == 0 || pb != 1 {
		t.Fatalf("expected pb to take over, hits pa=%d pb=%d", pa, pb)
	}
	if blocked.closes.Load() == 0 {
		t.Fatal("stalled error body was not closed")
	}
}

// ctxBody：正文的 Close / 读取也受上游请求 ctx 约束（真实 http.Response.Body 就是如此）。
type ctxBody struct {
	b   *blockingBody
	ctx context.Context
}

func (c *ctxBody) Read(p []byte) (int, error) {
	for {
		b, err := c.Next()
		if len(b) > 0 {
			return copy(p, b), nil
		}
		if err != nil {
			return 0, err
		}
	}
}

func (c *ctxBody) Next() ([]byte, error) {
	if c.ctx.Err() != nil {
		return nil, errors.New("context canceled")
	}
	return c.b.Next()
}
func (c *ctxBody) Close() error { return c.b.Close() }

// 错误正文读完后一切照旧：错误消息来自正文，状态码与尾部不丢。
func TestErrorBodyNormalTextStillUsed(t *testing.T) {
	var pbHits atomic.Int32
	g := CreateGateway(testErrorBodyCfg(t), errorBodyHooks(t, func(req *http.Request) (*http.Response, error) {
		if strings.HasPrefix(req.URL.Host, "pa.") {
			return errResponse(req, 500, io.NopCloser(strings.NewReader(`{"error":{"message":"pa exploded"}}`))), nil
		}
		pbHits.Add(1)
		return errResponse(req, 200, io.NopCloser(strings.NewReader(chatOK))), nil
	}))
	defer g.Stop()

	rec := sendChat(g)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "from-pb") {
		t.Fatalf("expected pb to answer, got %d %s", rec.Code, rec.Body.String())
	}
	if pbHits.Load() != 1 {
		t.Fatalf("pb hits = %d", pbHits.Load())
	}
}

func TestErrorBodyAllCandidatesFailReportsStatus(t *testing.T) {
	var paHits, pbHits atomic.Int32
	g := CreateGateway(testErrorBodyCfg(t), errorBodyHooks(t, func(req *http.Request) (*http.Response, error) {
		if strings.HasPrefix(req.URL.Host, "pa.") {
			paHits.Add(1)
			return errResponse(req, 500, &ctxBody{b: newBlockingBody(""), ctx: req.Context()}), nil
		}
		pbHits.Add(1)
		return errResponse(req, 401, io.NopCloser(strings.NewReader(`{"error":{"message":"bad key"}}`))), nil
	}))
	defer g.Stop()

	start := time.Now()
	rec := sendChat(g)
	if elapsed := time.Since(start); elapsed > time.Duration(ErrorBodyIdleMs+5_000)*time.Millisecond {
		t.Fatalf("requests returned too late: %v", elapsed)
	}
	body := rec.Body.String()
	// 正文卡住的 500 按已知状态换下一家：不必把 pa 的重连预算（SingleKeyRetries）吃完才换
	if paHits.Load() > 2 {
		t.Fatalf("stalled error body burned same-key retries: pa hits = %d", paHits.Load())
	}
	// 不无限重试：最后一家是 401（不可重连，同一 Key 只打一次），客户端拿到的是
	// 网关的多候选失败状态（上游 401 映射为 502）与 pb 的认证错误
	if pbHits.Load() != 1 {
		t.Fatalf("pb hits = %d", pbHits.Load())
	}
	if rec.Code < 400 || !strings.Contains(body, "bad key") {
		t.Fatalf("expected an error carrying pb message, got %d %s", rec.Code, body)
	}
}

// 客户端在等错误正文时离开：请求及时结束，不会等满读取上限。
func TestErrorBodyClientCancelReturnsPromptly(t *testing.T) {
	blocked := newBlockingBody("")
	g := CreateGateway(testErrorBodyCfg(t), errorBodyHooks(t, func(req *http.Request) (*http.Response, error) {
		return errResponse(req, 503, &ctxBody{b: blocked, ctx: req.Context()}), nil
	}))
	defer g.Stop()

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "http://127.0.0.1:18721/v1/chat/completions", bytes.NewReader([]byte(`{"model":"pa/m1","messages":[{"role":"user","content":"hi"}]}`))).WithContext(ctx)
	req.Host = "127.0.0.1:18721"
	req.RequestURI = "/v1/chat/completions"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer tok-dsh")
	done := make(chan struct{})
	go func() {
		g.ServeHTTP(httptest.NewRecorder(), req)
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not end after the client went away")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("cancel took %v", elapsed)
	}
	if blocked.closes.Load() == 0 {
		t.Fatal("error body was not closed after cancel")
	}
}

// 正常长流：成功 2xx 的 SSE 正文持续很久也不受错误正文上限影响。
func TestSuccessLongStreamNotTruncated(t *testing.T) {
	const (
		chunks = 30
		gap    = 100 * time.Millisecond
	)
	var pr *io.PipeReader
	var pw *io.PipeWriter
	var producerDone chan struct{}
	var stopped atomic.Bool
	paHits := 0
	g := CreateGateway(testErrorBodyCfg(t), errorBodyHooks(t, func(req *http.Request) (*http.Response, error) {
		if !strings.HasPrefix(req.URL.Host, "pa.") {
			return nil, errors.New("pb must not be used")
		}
		paHits++
		if paHits > 1 {
			return nil, errors.New("unexpected retry")
		}
		producerDone = make(chan struct{})
		pr, pw = io.Pipe()
		go func() {
			defer close(producerDone)
			// 写完 [DONE] 要关 writer（EOF），否则网关会一直等正文；提前返回的每条路径也一样要关。
			defer pw.Close()
			for i := 0; i < chunks; i++ {
				if stopped.Load() {
					return
				}
				ev := `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m1",` +
					`"choices":[{"index":0,"delta":{"content":"chunk-` + string(rune('a'+i%26)) + `"},"finish_reason":null}]}` + "\n\n"
				if _, err := pw.Write([]byte(ev)); err != nil {
					return
				}
				time.Sleep(gap)
			}
			_, _ = pw.Write([]byte("data: [DONE]\n\n"))
		}()
		return &http.Response{StatusCode: 200, Status: "OK",
			Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: &testEventStream{pr: pr, done: producerDone}, Request: req}, nil
	}))
	defer g.Stop()

	body := `{"model":"pa/m1","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "http://127.0.0.1:18721/v1/chat/completions", bytes.NewReader([]byte(body)))
	req.Host = "127.0.0.1:18721"
	req.RequestURI = "/v1/chat/completions"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer tok-dsh")
	rec := httptest.NewRecorder()
	start := time.Now()
	g.ServeHTTP(rec, req)
	elapsed := time.Since(start)
	stopped.Store(true)
	if pr != nil {
		_ = pr.Close()
	}
	if producerDone != nil {
		select {
		case <-producerDone:
		case <-time.After(2 * time.Second):
			t.Fatal("upstream stream producer did not finish")
		}
	}
	if rec.Code != 200 {
		t.Fatalf("stream status %d", rec.Code)
	}
	if elapsed < time.Duration(chunks)*gap {
		t.Fatalf("stream finished too early (%v): body was cut", elapsed)
	}
	out := rec.Body.String()
	if got := strings.Count(out, "chunk-"); got != chunks {
		t.Fatalf("expected %d streamed chunks, got %d: %s", chunks, got, out)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Fatalf("stream not terminated normally: %s", out)
	}
}

// testEventStream：成功的 2xx SSE 正文。Close 先停 producer 再关读端，免得 producer 卡在写。
type testEventStream struct {
	pr   *io.PipeReader
	done <-chan struct{}
	once sync.Once
}

func (s *testEventStream) Read(p []byte) (int, error) { return s.pr.Read(p) }

func (s *testEventStream) Close() error {
	s.once.Do(func() {
		_ = s.pr.Close()
		<-s.done
	})
	return nil
}
