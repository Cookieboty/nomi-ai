package tts

import (
	"log"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts/edge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// TestResult = TTSTestResult（latency 可缺省）
type TestResult struct {
	Success bool
	Message string
	Latency *int64
}

func (r TestResult) Obj() *util.Obj {
	o := util.NewObj("success", r.Success, "message", r.Message)
	if r.Latency != nil {
		o.Set("latency", *r.Latency)
	}
	return o
}

func (r TestResult) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(r.Obj())), nil }

// EdgeBackend：Edge 引擎（合成 + 打断 + 状态）
type EdgeBackend interface {
	EdgeEngine
	Stop()
	GetStatus() edge.Status
}

// Deps = TtsServiceDeps
type Deps struct {
	UserData string
	Env      map[string]string
	Edge     EdgeBackend
	// SendToMascot = sendMascotCommand(events, cmd)（main.go：router.Emit("mascot.command", cmd)）
	SendToMascot func(cmd *util.Obj)
	T            func(key string, args ...any) string
	// ListVoices = listChineseVoices（测试注入）
	ListVoices func() edge.VoiceList
	Now        func() time.Time
	Logf       func(format string, args ...any)
}

// Service = TtsService
type Service struct {
	d      Deps
	store  *Store
	router *Router
}

func New(d Deps) *Service {
	if d.Env == nil {
		d.Env = map[string]string{}
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logf == nil {
		d.Logf = log.Printf
	}
	s := &Service{d: d, store: &Store{UserData: d.UserData, Now: d.Now}}
	s.router = &Router{
		GetConfig: func() RouteConfig { return ApplyEnvOverride(FromConfig(s.store.Load()), s.d.Env) },
		Edge:      d.Edge,
		Now:       d.Now,
		OnOutcome: func(o Outcome) { s.d.Logf("[tts] tts:speak %+v", o) },
	}
	return s
}

func i64(v int64) *int64 { return &v }

func (s *Service) notAvailable(provider string) TestResult {
	if provider == "none" {
		return TestResult{Success: true, Message: s.d.T("electron.common.no-realtime-tts-engine-selected")}
	}
	return TestResult{Message: s.d.T("electron.common.this-tts-engine-is-not-available-yet")}
}

// Overlay：{...store.load(), ...cfg, enabled: true} 里 cfg 的字段（Has=键存在；值 nil=undefined）
type Overlay struct {
	Provider     string
	HasEdgeVoice bool
	EdgeVoice    *string
	HasRate      bool
	Rate         *float64
}

func (s *Service) previewRouter(ov Overlay) *Router {
	return &Router{
		GetConfig: func() RouteConfig {
			c := FromConfig(s.store.Load())
			c.Provider = ov.Provider
			if ov.HasEdgeVoice {
				c.EdgeVoice = ov.EdgeVoice
			}
			if ov.HasRate {
				c.Rate = ov.Rate
			}
			c.Enabled = true
			return ApplyEnvOverride(c, s.d.Env)
		},
		Edge: s.d.Edge,
		Now:  s.d.Now,
	}
}

// GetConfig：Load 不会抛（读失败已回落默认），所以总是非 nil
func (s *Service) GetConfig() *Config { c := s.store.Load(); return &c }

func (s *Service) SaveConfig(input any) (Config, error) {
	c, err := s.store.Save(input)
	if err != nil {
		s.d.Logf("[tts] TTS配置保存失败 %s", err.Error())
		return c, err
	}
	s.d.Logf("[tts] TTS配置保存成功 provider=%s enabled=%v", c.Provider, c.Enabled)
	return c, nil
}

func (s *Service) ResetConfig() error {
	if err := s.store.Reset(); err != nil {
		s.d.Logf("[tts] 重置TTS配置失败 %s", err.Error())
		return err
	}
	s.d.Logf("[tts] TTS配置已重置")
	return nil
}

// TestConnection(config)：config 是视图传入的原始对象（未知字段透传）
func (s *Service) TestConnection(raw any) TestResult {
	cfg := asObj(raw)
	provider, _ := cfg.Get("provider").(string)
	if provider != "edge" {
		r := s.notAvailable(provider)
		r.Latency = i64(0)
		return r
	}
	ov := Overlay{Provider: provider}
	if cfg.Has("edgeVoice") {
		ov.HasEdgeVoice = true
		if v, ok := cfg.Get("edgeVoice").(string); ok {
			ov.EdgeVoice = &v
		}
	}
	if cfg.Has("rate") {
		ov.HasRate = true
		if f, ok := cfg.Get("rate").(float64); ok {
			ov.Rate = &f
		}
	}
	t0 := s.d.Now()
	r := s.previewRouter(ov).Speak(s.d.T("electron.common.tts-test-sentence"))
	if r.Success {
		return TestResult{Success: true, Message: s.d.T("electron.common.realtime-tts-reachable"), Latency: i64(s.d.Now().Sub(t0).Milliseconds())}
	}
	return TestResult{Message: s.d.T("electron.common.realtime-tts-unreachable"), Latency: i64(0)}
}

// Preview(req)：edgeVoice / rate 总是覆盖（未传 = undefined）
func (s *Service) Preview(text, provider string, edgeVoice *string, rate *float64) SpeakResult {
	ov := Overlay{Provider: provider, HasEdgeVoice: true, EdgeVoice: edgeVoice, HasRate: true, Rate: rate}
	return s.previewRouter(ov).Speak(util.UTF16Slice0(text, 300))
}

func (s *Service) Voices() edge.VoiceList {
	if s.d.Env["CD_TTS"] == "off" {
		return edge.VoiceList{Voices: append([]edge.Voice(nil), edge.BuiltinZhVoices...), Source: "builtin"}
	}
	if s.d.ListVoices != nil {
		return s.d.ListVoices()
	}
	return edge.ListChineseVoices(edge.DefaultFetcher, 8*time.Second)
}

func (s *Service) Status() edge.Status { return s.d.Edge.GetStatus() }

func (s *Service) Stop() bool { s.d.Edge.Stop(); return true }

func (s *Service) Speak(text string) SpeakResult { return s.router.Speak(text) }

func (s *Service) Reply(msg any) bool {
	c := s.store.Load()
	cmd := ReplySpeechCommand(msg, &c, s.d.Env)
	if cmd == nil {
		return false
	}
	if s.d.SendToMascot != nil {
		s.d.SendToMascot(cmd)
	}
	return true
}

func (s *Service) PromptVoice() bool { return s.store.Load().PromptVoice }

// Health(config?)：provider 缺省读已存配置
func (s *Service) Health(provider *string) TestResult {
	p := ""
	if provider != nil {
		p = *provider
	} else {
		p = s.store.Load().Provider
	}
	if p == "edge" {
		if s.d.Edge.GetStatus().ConsecutiveFailures >= 3 {
			return TestResult{Message: s.d.T("electron.common.realtime-tts-unreachable")}
		}
		return TestResult{Success: true, Message: s.d.T("electron.common.realtime-tts-reachable")}
	}
	r := s.notAvailable(p)
	r.Success = false
	return r
}
