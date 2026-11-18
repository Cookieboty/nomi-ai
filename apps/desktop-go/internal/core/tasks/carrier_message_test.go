package tasks

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// 续跑配置不一致的提示：不点名 agent、不带占位符、不谈账号 / 模型，说明工作已保留与如何继续
func TestCarrierConfigChangedMessage(t *testing.T) {
	for _, loc := range []string{"zh-CN", "en"} {
		t.Run(loc, func(t *testing.T) {
			i18n.SetLocale(func() string { return loc })
			t.Cleanup(func() { i18n.SetLocale(nil) })
			msg := carrierConfigChanged()
			if strings.Contains(msg, "{0}") || strings.Contains(msg, "{1}") || strings.ContainsAny(msg, "{}") {
				t.Fatalf("%s: message has placeholders: %q", loc, msg)
			}
			for _, leak := range []string{"Claude", "Codex", "claude", "codex"} {
				if strings.Contains(msg, leak) {
					t.Fatalf("%s: message names an agent: %q", loc, msg)
				}
			}
			if strings.TrimSpace(msg) == "" || msg == "electron.common.task-config-carrier-cli-changed" {
				t.Fatalf("%s: message not resolved: %q", loc, msg)
			}
			// 说明工作保留 + 如何继续
			want := map[string][]string{
				"zh-CN": {"保留", "继续"},
				"en":    {"kept", "Continue"},
			}[loc]
			for _, w := range want {
				if !strings.Contains(msg, w) {
					t.Fatalf("%s: message lacks %q: %q", loc, w, msg)
				}
			}
		})
	}
}
