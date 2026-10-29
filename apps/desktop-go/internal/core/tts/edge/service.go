package edge

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/types"
)

// MaxSegmentChars = MAX_SEGMENT_CHARS
const MaxSegmentChars = 600

// DefaultEdgeVoice / DefaultTtsRate = @nomi-ai/types
const (
	DefaultEdgeVoice = "zh-CN-XiaoyiNeural"
	DefaultTtsRate   = -5
)

// SpeakParams = EdgeSpeakParams；Rate nil = 未给
type SpeakParams struct {
	Text  string
	Voice string
	Rate  *float64
}

// SpeakResult = EdgeSpeakOk | EdgeSpeakFail
type SpeakResult struct {
	OK      bool
	Audio   []byte
	Kind    string
	Message string
}

// Status = TTSStatus（毫秒时间戳，nil = 没有）
type Status struct {
	ConsecutiveFailures int
	LastSuccessAt       *int64
	LastFailureAt       *int64
	// successFirst：lastSuccessAt 比 lastFailureAt 先出现（对象展开保持首次插入的键序）
	successFirst bool
}

// Obj：JSON 形状，键序同 Node 的对象展开
func (s Status) Obj() *util.Obj {
	o := util.NewObj("consecutiveFailures", s.ConsecutiveFailures)
	add := func(k string, v *int64) {
		if v != nil {
			o.Set(k, *v)
		}
	}
	if s.successFirst {
		add("lastSuccessAt", s.LastSuccessAt)
		add("lastFailureAt", s.LastFailureAt)
	} else {
		add("lastFailureAt", s.LastFailureAt)
		add("lastSuccessAt", s.LastSuccessAt)
	}
	return o
}

func (s Status) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(s.Obj())), nil }

// Synthesizer = Pick<EdgeTtsClient, 'synthesize'>
type Synthesizer interface {
	Synthesize(ctx context.Context, text string, o SynthOptions) ([]byte, error)
}

// Service = EdgeTtsService
type Service struct {
	client   Synthesizer
	now      func() time.Time
	mu       sync.Mutex
	inflight map[*context.CancelFunc]struct{}
	status   Status
}

// NewService = new EdgeTtsService(client, now)
func NewService(c Synthesizer, now func() time.Time) *Service {
	if c == nil {
		c = NewClient(nil)
	}
	if now == nil {
		now = time.Now
	}
	return &Service{client: c, now: now, inflight: map[*context.CancelFunc]struct{}{}}
}

// Speak = speak(p)
func (s *Service) Speak(p SpeakParams) SpeakResult {
	text := types.SliceUTF16(types.CleanTextForSpeech(p.Text), 0, MaxSegmentChars)
	if !types.HasLetterOrNumber(text) {
		return SpeakResult{Kind: "empty", Message: "nothing to read"}
	}
	voice := DefaultEdgeVoice
	if p.Voice != "" && VoiceNameRe.MatchString(p.Voice) {
		voice = p.Voice
	}
	rate := float64(DefaultTtsRate)
	if p.Rate != nil && !math.IsNaN(*p.Rate) && !math.IsInf(*p.Rate, 0) {
		rate = *p.Rate
	}
	ctx, cancel := context.WithCancel(context.Background())
	key := &cancel
	s.mu.Lock()
	s.inflight[key] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.inflight, key)
		s.mu.Unlock()
		cancel()
	}()
	audio, err := s.client.Synthesize(ctx, text, SynthOptions{Voice: voice, Rate: rate})
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil {
		t := s.now().UnixMilli()
		s.status.ConsecutiveFailures = 0
		if s.status.LastSuccessAt == nil && s.status.LastFailureAt == nil {
			s.status.successFirst = true
		}
		s.status.LastSuccessAt = &t
		return SpeakResult{OK: true, Audio: audio}
	}
	kind := string(KindProtocol)
	var te *TtsError
	if errors.As(err, &te) {
		kind = string(te.Kind)
	}
	// 被打断不算失败
	if kind != string(KindAborted) {
		t := s.now().UnixMilli()
		s.status.ConsecutiveFailures++
		s.status.LastFailureAt = &t
	}
	return SpeakResult{Kind: kind, Message: err.Error()}
}

// Stop 取消所有还在等音频的请求
func (s *Service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.inflight {
		(*k)()
	}
	clear(s.inflight)
}

// GetStatus = getStatus()
func (s *Service) GetStatus() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}
