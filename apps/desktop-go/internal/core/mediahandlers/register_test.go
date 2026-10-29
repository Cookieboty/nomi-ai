package mediahandlers

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract/gen"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
)

// 所有 voice.* / tts.* 契约过程都由批次 9 注册（不再落到 UNAVAILABLE 桩），且没有契约外的名字
func TestInstallCoversVoiceAndTTS(t *testing.T) {
	r := contract.NewRouter()
	Install(r, Deps{Voice: voice.NewService(voice.Deps{Root: t.TempDir()}), Logf: t.Logf, OpenVoiceSettings: func() {}})
	have := r.Registered()
	known := map[string]bool{}
	for _, p := range gen.Procedures {
		known[p.Name] = true
		if strings.HasPrefix(p.Name, "voice.") || strings.HasPrefix(p.Name, "tts.") || p.Name == "nav.openVoiceSettings" {
			if _, ok := have[p.Name]; !ok {
				t.Errorf("%s not registered", p.Name)
			}
		}
	}
	for n := range have {
		if !known[n] {
			t.Errorf("%s registered but not in contract", n)
		}
	}
}
