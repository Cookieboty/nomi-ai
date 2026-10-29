// Package tts 对应 packages/core/src/tts：配置（tts-config.json）、路由、朗读回复、TtsService。
// Edge 引擎在 ./edge；Azure / OpenAI 与 Node 一样「尚未实现」，静默。
package tts

import (
	"math"
	"slices"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts/edge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Providers = TTS_PROVIDERS
var Providers = []string{"none", "edge", "azure", "openai"}

// Config = TTSConfig（normalize 之后的完整形状；键序同 Node）
type Config struct {
	Enabled      bool
	PromptVoice  bool
	Provider     string
	EdgeVoice    string
	Rate         float64
	ReadReplies  bool
	LastModified float64
}

// Default = { ...DEFAULT_TTS_CONFIG, lastModified: 0 }
func Default() Config {
	return Config{Enabled: true, PromptVoice: true, Provider: "edge", EdgeVoice: edge.DefaultEdgeVoice, Rate: edge.DefaultTtsRate, ReadReplies: true}
}

func negZero(f float64) float64 {
	if f == 0 {
		return 0
	}
	return f
}

// Obj：JSON 形状（键序 enabled, promptVoice, provider, edgeVoice, rate, readReplies, lastModified）
func (c Config) Obj() *util.Obj {
	return util.NewObj("enabled", c.Enabled, "promptVoice", c.PromptVoice, "provider", c.Provider,
		"edgeVoice", c.EdgeVoice, "rate", negZero(c.Rate), "readReplies", c.ReadReplies, "lastModified", negZero(c.LastModified))
}

func (c Config) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(c.Obj())), nil }

func asObj(raw any) *util.Obj {
	if o, ok := raw.(*util.Obj); ok && o != nil {
		return o
	}
	return util.NewObj()
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// Normalize = normalizeTtsConfig(raw)；raw 是 util.Parse 的结果
func Normalize(raw any) Config {
	r := asObj(raw)
	c := Default()
	c.Enabled = r.Get("enabled") != false
	c.PromptVoice = r.Get("promptVoice") != false
	c.Provider = "none"
	if p, ok := r.Get("provider").(string); ok && slices.Contains(Providers, p) {
		c.Provider = p
	}
	if v, ok := r.Get("edgeVoice").(string); ok && edge.VoiceNameRe.MatchString(v) {
		c.EdgeVoice = v
	}
	if f, ok := r.Get("rate").(float64); ok && isFinite(f) {
		c.Rate = math.Floor(math.Max(-50, math.Min(50, f)) + 0.5)
	}
	c.ReadReplies = r.Get("readReplies") != false
	c.LastModified = 0
	if f, ok := r.Get("lastModified").(float64); ok {
		c.LastModified = f
	}
	return c
}

func present(o *util.Obj, k string) bool { // c.k != null
	v := o.Get(k)
	_, undef := v.(util.JSUndefined)
	return o.Has(k) && v != nil && !undef
}

// Validate = validateTtsConfig(config)
func Validate(raw any) (bool, []string) {
	c := asObj(raw)
	errs := []string{}
	if p, ok := c.Get("provider").(string); !ok || !slices.Contains(Providers, p) {
		errs = append(errs, "provider must be one of "+strings.Join(Providers, ", "))
	}
	isBool := func(k string) bool { _, ok := c.Get(k).(bool); return ok }
	if present(c, "enabled") && !isBool("enabled") {
		errs = append(errs, "enabled must be boolean")
	}
	if present(c, "promptVoice") && !isBool("promptVoice") {
		errs = append(errs, "promptVoice must be boolean")
	}
	if present(c, "edgeVoice") {
		if v, ok := c.Get("edgeVoice").(string); !ok || !edge.VoiceNameRe.MatchString(v) {
			errs = append(errs, "edgeVoice must be a voice short name like zh-CN-XiaoyiNeural")
		}
	}
	if present(c, "rate") {
		if f, ok := c.Get("rate").(float64); !ok || !isFinite(f) || math.Abs(f) > 50 {
			errs = append(errs, "rate must be a number between -50 and 50")
		}
	}
	if present(c, "readReplies") && !isBool("readReplies") {
		errs = append(errs, "readReplies must be boolean")
	}
	return len(errs) == 0, errs
}
