package voice

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// MascotConfig：config.json 的 voiceSettings 读写（ConfigService 适配）
type MascotConfig interface {
	GetVoiceSettings() *util.Obj // nil = undefined
	SetVoiceSettings(v *util.Obj)
	Save() error
}

// GetMascotVoiceSettings = getMascotVoiceSettings(config)
func GetMascotVoiceSettings(c MascotConfig) any {
	if v := c.GetVoiceSettings(); v != nil {
		return v
	}
	return util.JSUndefined{}
}

// SaveMascotVoiceSettings = saveMascotVoiceSettings(config, settings, logger, events)
func SaveMascotVoiceSettings(c MascotConfig, settings *util.Obj, logf func(string, ...any), publish func(name string, payload any)) {
	cur := c.GetVoiceSettings()
	updated := util.NewObj()
	if cur != nil {
		updated.Assign(cur)
	}
	if settings != nil {
		updated.Assign(settings)
	}
	c.SetVoiceSettings(updated)
	if publish != nil {
		publish("voice.mascotSettingsChanged", updated)
	}
	if err := c.Save(); err != nil && logf != nil {
		logf("保存语音设置失败 %v", err)
	}
}
