package tts

import (
	"encoding/base64"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts/edge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RouteConfig 是路由读到的配置（预览时 edgeVoice / rate 可能被未定义值覆盖 → nil）
type RouteConfig struct {
	Enabled   bool
	Provider  string
	EdgeVoice *string
	Rate      *float64
}

// FromConfig：完整配置 → 路由配置
func FromConfig(c Config) RouteConfig {
	v, r := c.EdgeVoice, c.Rate
	return RouteConfig{Enabled: c.Enabled, Provider: c.Provider, EdgeVoice: &v, Rate: &r}
}

// ApplyEnvOverride = applyTtsEnvOverride(cfg, env)
func ApplyEnvOverride(c RouteConfig, env map[string]string) RouteConfig {
	if env["CD_TTS"] == "off" {
		c.Enabled = false
	}
	return c
}

// SpeakResult = TTSSpeakResult
type SpeakResult struct {
	Success     bool
	AudioBase64 string
	MimeType    string
	Via         string
	Message     string
}

// Obj：成功 {success,audioBase64,mimeType,via}，静默 {success,via,message}
func (r SpeakResult) Obj() *util.Obj {
	if r.Success {
		return util.NewObj("success", true, "audioBase64", r.AudioBase64, "mimeType", r.MimeType, "via", r.Via)
	}
	return util.NewObj("success", false, "via", r.Via, "message", r.Message)
}

func (r SpeakResult) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(r.Obj())), nil }

// Outcome = TtsSpeakOutcome
type Outcome struct {
	Outcome    string `json:"outcome"`
	Provider   string `json:"provider"`
	Via        string `json:"via"`
	Ms         int64  `json:"ms"`
	TextLength int    `json:"textLength"`
	Message    string `json:"message,omitempty"`
}

// EdgeEngine = TtsEdgeEngine
type EdgeEngine interface {
	Speak(p edge.SpeakParams) edge.SpeakResult
}

// Router = TtsRouter
type Router struct {
	GetConfig func() RouteConfig
	Edge      EdgeEngine
	OnOutcome func(Outcome)
	Now       func() time.Time
}

func silent(msg string) SpeakResult { return SpeakResult{Via: "none", Message: msg} }

// Speak = speak(req)
func (r *Router) Speak(text string) SpeakResult {
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	t0 := now()
	cfg := r.GetConfig()
	res := r.route(text, cfg)
	if r.OnOutcome != nil {
		o := "fallback"
		if res.Success {
			o = "success"
		}
		r.OnOutcome(Outcome{Outcome: o, Provider: cfg.Provider, Via: res.Via, Ms: now().Sub(t0).Milliseconds(), TextLength: util.UTF16Len(text), Message: res.Message})
	}
	return res
}

func (r *Router) route(text string, cfg RouteConfig) SpeakResult {
	if util.JSTrim(text) == "" {
		return silent("empty text")
	}
	if !cfg.Enabled {
		return silent("tts disabled")
	}
	if cfg.Provider == "none" {
		return silent("no realtime TTS engine")
	}
	if cfg.Provider == "edge" && r.Edge != nil {
		p := edge.SpeakParams{Text: text, Rate: cfg.Rate}
		if cfg.EdgeVoice != nil {
			p.Voice = *cfg.EdgeVoice
		}
		res := r.Edge.Speak(p)
		if !res.OK {
			return silent("edge: " + res.Kind)
		}
		return SpeakResult{Success: true, AudioBase64: base64.StdEncoding.EncodeToString(res.Audio), MimeType: "audio/mpeg", Via: "edge"}
	}
	return silent(cfg.Provider + " TTS is not implemented yet")
}
