package voice

import (
	"math"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// VolcResources = VOLC_RESOURCES（设置仍接受；豆包引擎本身不在 Go 版：D-B9-1）
var VolcResources = []string{"volc.seedasr.sauc.duration", "volc.seedasr.sauc.concurrent"}

const VolcTargetID = "volc:openspeech.bytedance.com"

type WakeWord struct {
	Enabled   bool
	Phrase    string
	WindowSec float64
}

// Settings = VoiceSettings（userData/voice/settings.json）
type Settings struct {
	Engine         string
	Language       string
	WhisperModel   string
	WhisperCliPath string
	ProviderID     string
	CustomBaseURL  string
	CloudModel     string
	VolcResourceID string
	VolcFallback   bool
	CloudAcked     []string
	AutoSend       bool
	BargeIn        bool
	VadThreshold   float64
	WakeWord       WakeWord
}

// DefaultSettings = DEFAULT_VOICE_SETTINGS
func DefaultSettings() Settings {
	return Settings{Engine: "whisper-cpp", Language: "auto", WhisperModel: "ggml-base", CloudModel: "whisper-1",
		VolcResourceID: "volc.seedasr.sauc.duration", CloudAcked: []string{}, AutoSend: true, BargeIn: true,
		VadThreshold: 0.5, WakeWord: WakeWord{Phrase: "", WindowSec: 8}}
}

func nz(f float64) float64 {
	if f == 0 {
		return 0
	}
	return f
}

// Obj：键序同 Node 对象字面量
func (s Settings) Obj() *util.Obj {
	acked := make([]any, len(s.CloudAcked))
	for i, a := range s.CloudAcked {
		acked[i] = a
	}
	return util.NewObj("engine", s.Engine, "language", s.Language, "whisperModel", s.WhisperModel,
		"whisperCliPath", s.WhisperCliPath, "providerId", s.ProviderID, "customBaseURL", s.CustomBaseURL,
		"cloudModel", s.CloudModel, "volcResourceId", s.VolcResourceID, "volcFallback", s.VolcFallback,
		"cloudAcked", acked, "autoSend", s.AutoSend, "bargeIn", s.BargeIn, "vadThreshold", nz(s.VadThreshold),
		"wakeWord", util.NewObj("enabled", s.WakeWord.Enabled, "phrase", s.WakeWord.Phrase, "windowSec", nz(s.WakeWord.WindowSec)))
}

func (s Settings) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(s.Obj())), nil }

func objOf(v any) *util.Obj {
	if o, ok := v.(*util.Obj); ok && o != nil {
		return o
	}
	return util.NewObj()
}

func sstr(v any, d string, max int) string {
	if s, ok := v.(string); ok {
		return util.UTF16Slice0(util.JSTrim(s), max)
	}
	return d
}

func sbool(v any, d bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return d
}

func snum(v any, d, lo, hi float64) float64 {
	if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return math.Min(hi, math.Max(lo, f))
	}
	return d
}

var (
	langRe = regexp.MustCompile(`^(auto|[a-z]{2,3})$`)
	httpRe = regexp.MustCompile(`(?i)^https?://`)
)

// Sanitize = sanitizeVoiceSettings(raw, base)；raw 为 util.Parse 的值
func Sanitize(raw any, base Settings) Settings {
	r := objOf(raw)
	ww := objOf(r.Get("wakeWord"))
	lang := sstr(r.Get("language"), base.Language, 8)
	u := sstr(r.Get("customBaseURL"), base.CustomBaseURL, 500)
	out := Settings{}
	switch e, _ := r.Get("engine").(string); e {
	case "openai-compat", "whisper-cpp", "volc":
		out.Engine = e
	default:
		out.Engine = base.Engine
	}
	out.Language = base.Language
	if langRe.MatchString(lang) {
		out.Language = lang
	}
	out.WhisperModel = sstr(r.Get("whisperModel"), base.WhisperModel, 64)
	out.WhisperCliPath = sstr(r.Get("whisperCliPath"), base.WhisperCliPath, 1000)
	out.ProviderID = sstr(r.Get("providerId"), base.ProviderID, 128)
	out.CustomBaseURL = base.CustomBaseURL
	if u == "" || httpRe.MatchString(u) {
		out.CustomBaseURL = u
	}
	if out.CloudModel = sstr(r.Get("cloudModel"), base.CloudModel, 128); out.CloudModel == "" {
		out.CloudModel = "whisper-1"
	}
	if v, ok := r.Get("volcResourceId").(string); ok && slices.Contains(VolcResources, v) {
		out.VolcResourceID = v
	} else if out.VolcResourceID = base.VolcResourceID; out.VolcResourceID == "" {
		out.VolcResourceID = DefaultSettings().VolcResourceID
	}
	out.VolcFallback = sbool(r.Get("volcFallback"), base.VolcFallback)
	if arr, ok := r.Get("cloudAcked").([]any); ok {
		out.CloudAcked = []string{}
		for _, x := range arr {
			if s, ok := x.(string); ok {
				out.CloudAcked = append(out.CloudAcked, s)
			}
		}
		if len(out.CloudAcked) > 50 {
			out.CloudAcked = out.CloudAcked[:50]
		}
	} else {
		out.CloudAcked = append([]string{}, base.CloudAcked...)
	}
	out.AutoSend = sbool(r.Get("autoSend"), base.AutoSend)
	out.BargeIn = sbool(r.Get("bargeIn"), base.BargeIn)
	out.VadThreshold = snum(r.Get("vadThreshold"), base.VadThreshold, 0.3, 0.9)
	out.WakeWord = WakeWord{
		Enabled:   sbool(ww.Get("enabled"), base.WakeWord.Enabled),
		Phrase:    sstr(ww.Get("phrase"), base.WakeWord.Phrase, 24),
		WindowSec: snum(ww.Get("windowSec"), base.WakeWord.WindowSec, 3, 30),
	}
	return out
}

// URLOrigin = new URL(s).origin（http/https；失败 ok=false）
func URLOrigin(s string) (string, bool) {
	u, err := url.Parse(util.JSTrim(s))
	if err != nil || u.Host == "" || u.Scheme == "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Host)
	if (scheme == "http" && strings.HasSuffix(host, ":80")) || (scheme == "https" && strings.HasSuffix(host, ":443")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	return scheme + "://" + host, true
}

// CloudTargetID = cloudTargetId(s)
func CloudTargetID(s Settings) string {
	if s.Engine == "volc" {
		return VolcTargetID
	}
	if s.CustomBaseURL != "" {
		if o, ok := URLOrigin(s.CustomBaseURL); ok {
			return "url:" + o
		}
		return "url:invalid"
	}
	return s.ProviderID
}
