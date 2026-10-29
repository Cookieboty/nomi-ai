package tts

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CanReadReplies = canReadReplies(cfg)
func CanReadReplies(c *Config) bool {
	return c != nil && c.Enabled && c.Provider == "edge" && c.ReadReplies
}

// ReplySpeechCommand = replySpeechCommand(raw, cfg, env)；nil = 不转发。返回有序对象（mascot.command 载荷）
func ReplySpeechCommand(raw any, c *Config, env map[string]string) *util.Obj {
	m := asObj(raw)
	id, hasID := m.Get("id").(string)
	if hasID {
		id = util.UTF16Slice0(id, 80)
	}
	op, _ := m.Get("op").(string)
	if op == "stop" {
		o := util.NewObj("type", "reply-speech", "op", "stop")
		if hasID && id != "" {
			o.Set("id", id)
		}
		return o
	}
	if env["CD_TTS"] == "off" || id == "" || !CanReadReplies(c) {
		return nil
	}
	if op == "end" {
		return util.NewObj("type", "reply-speech", "op", "end", "id", id)
	}
	if t, ok := m.Get("text").(string); op == "say" && ok && util.JSTrim(t) != "" {
		return util.NewObj("type", "reply-speech", "op", "say", "id", id, "text", util.UTF16Slice0(t, 600))
	}
	return nil
}
