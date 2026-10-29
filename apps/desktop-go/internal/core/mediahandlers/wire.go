package mediahandlers

import (
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts/edge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ConfigAdapter：ConfigService 的 voiceSettings 读写（类型化配置：voiceSettings 下的未知键不保留，D-B9-3）
type ConfigAdapter struct{ C *services.ConfigService }

func (a ConfigAdapter) GetVoiceSettings() *util.Obj {
	b, _ := json.Marshal(a.C.GetConfig().VoiceSettings)
	v, _ := util.Parse(b)
	o, _ := v.(*util.Obj)
	return o
}

func (a ConfigAdapter) SetVoiceSettings(v *util.Obj) {
	_ = a.C.UpdateConfig(map[string]any{"voiceSettings": json.RawMessage(util.Stringify(v))})
}

func (a ConfigAdapter) Save() error { return a.C.Save() }

// WireDeps：main.go 提供的宿主能力
type WireDeps struct {
	UserData  string
	Router    *contract.Router
	Config    *services.ConfigService
	Env       map[string]string
	T         func(key string, args ...any) string
	Logf      func(string, ...any)
	LocalOnly func() bool
	Audit     func(voice.AuditEvent)
	OpenChat  func()
	// OpenChatOnceLoaded：打开对话窗口，页面还在加载时返回 did-finish-load 登记函数（nil = 已加载完）
	OpenChatOnceLoaded func() func(fn func())
	DefaultWakePhrase  func() string
	// TODO(batch-4/5)：AI runtime 的 listProviders / providerCredentials
	Providers   func() []voice.Provider
	Credentials func(id string) *voice.Credentials
}

// Wire 构造 TtsService / VoiceService 并注册契约过程
func Wire(d WireDeps) (*voice.Service, *tts.Service) {
	r := d.Router
	sendToMascot := func(cmd *util.Obj) { r.Emit("mascot.command", cmd) }
	ttsSvc := tts.New(tts.Deps{
		UserData:     d.UserData,
		Env:          d.Env,
		Edge:         edge.NewService(edge.NewClient(nil), time.Now),
		SendToMascot: sendToMascot,
		T:            d.T,
		Logf:         d.Logf,
	})
	voiceSvc := voice.NewService(voice.Deps{
		Root:        filepath.Join(d.UserData, "voice"),
		Secrets:     security.NewSecretBox("voice"),
		Providers:   d.Providers,
		Credentials: d.Credentials,
		LocalOnly:   d.LocalOnly,
		Audit:       d.Audit,
		OpenChat: func() func(func()) {
			if d.OpenChatOnceLoaded != nil {
				return d.OpenChatOnceLoaded()
			}
			d.OpenChat()
			return nil
		},
		Publish:           r.Emit,
		PublishChat:       func(n string, p any) { r.EmitTo(n, p, "chat") },
		SendToMascot:      sendToMascot,
		DefaultWakePhrase: d.DefaultWakePhrase,
		T:                 d.T,
		Logf:              d.Logf,
	})
	Install(r, Deps{
		Voice:  voiceSvc,
		TTS:    ttsSvc,
		Mascot: ConfigAdapter{d.Config},
		Logf:   d.Logf,
		OpenVoiceSettings: func() {
			d.OpenChat()
			r.Emit("nav.voiceSettingsRequested", map[string]any{})
		},
	})
	return voiceSvc, ttsSvc
}
