package mediahandlers

// 对应 apps/desktop-electron/internal/core/src/contract/media/voiceSenders.ts：调用方 → VoiceSender，'ai:voice:stream' 的推送
// 按会话 id 投到对应 voice.streamStart 的流里。调用方窗口的销毁 = 契约连接断开（caller.Done）。

import (
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// pushStream = PushStream：无界队列 + 结束标记（push 不阻塞，顺序保持）
type pushStream struct {
	mu    sync.Mutex
	q     []any
	ended bool
	wake  chan struct{}
}

func newPushStream() *pushStream { return &pushStream{wake: make(chan struct{}, 1)} }

func (p *pushStream) push(v any) {
	p.mu.Lock()
	if !p.ended {
		p.q = append(p.q, v)
	}
	p.mu.Unlock()
	p.signal()
}

func (p *pushStream) end() {
	p.mu.Lock()
	p.ended = true
	p.mu.Unlock()
	p.signal()
}

func (p *pushStream) signal() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// next：取出排队的 chunk；ended 且队列空时 done = true
func (p *pushStream) next() (items []any, done bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	items, p.q = p.q, nil
	return items, p.ended
}

type voiceStreams struct {
	mu      sync.Mutex
	streams map[string]struct {
		owner  int
		stream *pushStream
	}
}

func newVoiceStreams() *voiceStreams {
	return &voiceStreams{streams: map[string]struct {
		owner  int
		stream *pushStream
	}{}}
}

func (v *voiceStreams) open(id string, owner int, s *pushStream) {
	v.mu.Lock()
	if old, ok := v.streams[id]; ok {
		old.stream.end()
	}
	v.streams[id] = struct {
		owner  int
		stream *pushStream
	}{owner, s}
	v.mu.Unlock()
}

func (v *voiceStreams) close(id string, owner int) {
	v.mu.Lock()
	s, ok := v.streams[id]
	if !ok || s.owner != owner {
		v.mu.Unlock()
		return
	}
	delete(v.streams, id)
	v.mu.Unlock()
	s.stream.end()
}

func (v *voiceStreams) count() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.streams)
}

// callerSender = senderFor(windows, callerId)
type callerSender struct {
	c  contract.Caller
	vs *voiceStreams
}

func (v *voiceStreams) senderFor(c contract.Caller) *callerSender { return &callerSender{c, v} }

func (s *callerSender) ID() int { return s.c.ID }

func (s *callerSender) IsDestroyed() bool {
	if s.c.Done == nil {
		return false
	}
	select {
	case <-s.c.Done:
		return true
	default:
		return false
	}
}

func (s *callerSender) OnceDestroyed(fn func()) {
	if s.c.Done == nil {
		return
	}
	go func() {
		<-s.c.Done
		fn()
	}()
}

func (s *callerSender) Send(channel string, payload *util.Obj) {
	if channel != "ai:voice:stream" {
		return
	}
	id, ok := payload.Get("id").(string)
	if !ok {
		return
	}
	s.vs.mu.Lock()
	st, ok := s.vs.streams[id]
	s.vs.mu.Unlock()
	if ok {
		st.stream.push(payload)
	}
}
