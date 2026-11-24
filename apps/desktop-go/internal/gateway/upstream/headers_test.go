package upstream

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 供应商声明 quirks.sessionHeader 时，把会话稳定 ID 放进该头；没有 quirk 或没有会话时不发。
func TestSessionHeaderQuirk(t *testing.T) {
	p := relay(config.RuntimeModel{ID: "m1", Enabled: true})
	p.Quirks = config.QuirksFromObj(u.NewObj("sessionHeader", "x-opencode-session"))
	c := candOf(p, "m1", "chat")

	h := Headers(c, HeaderOpts{Stream: true, ClientHeaders: map[string]any{}, Session: "nomi:h:s1"})
	if got := h.Get("x-opencode-session"); got != "nomi:h:s1" {
		t.Fatalf("session header = %v", got)
	}

	h2 := Headers(c, HeaderOpts{Stream: true, ClientHeaders: map[string]any{}})
	if h2.Has("x-opencode-session") {
		t.Fatal("session header must be absent without a session")
	}

	plain := relay(config.RuntimeModel{ID: "m1", Enabled: true})
	h3 := Headers(candOf(plain, "m1", "chat"), HeaderOpts{Stream: true, ClientHeaders: map[string]any{}, Session: "nomi:h:s1"})
	if h3.Has("x-opencode-session") {
		t.Fatal("session header must not be sent without the quirk")
	}

	// 前后空白会被清理；非法头名（如换行或冒号）会被丢弃
	trimmed := relay(config.RuntimeModel{ID: "m1", Enabled: true})
	trimmed.Quirks = config.QuirksFromObj(u.NewObj("sessionHeader", "  x-opencode-session \t"))
	h4 := Headers(candOf(trimmed, "m1", "chat"), HeaderOpts{Stream: true, ClientHeaders: map[string]any{}, Session: "nomi:h:s1"})
	if got := h4.Get("x-opencode-session"); got != "nomi:h:s1" {
		t.Fatalf("trimmed session header = %v", got)
	}

	invalid := relay(config.RuntimeModel{ID: "m1", Enabled: true})
	invalid.Quirks = &config.ProviderQuirks{SessionHeader: "bad: header\r\n"}
	h5 := Headers(candOf(invalid, "m1", "chat"), HeaderOpts{Stream: true, ClientHeaders: map[string]any{}, Session: "nomi:h:s1"})
	if h5.Has("bad: header\r\n") || h5.Has("bad") {
		t.Fatalf("invalid session header must not be sent: %s", u.Stringify(h5))
	}

	// 用户自定义 Provider.Headers 中存在不同大小写的同名头时，不重复写入另一份
	override := relay(config.RuntimeModel{ID: "m1", Enabled: true})
	override.Quirks = config.QuirksFromObj(u.NewObj("sessionHeader", "x-opencode-session"))
	override.Headers = u.NewObj("X-Opencode-Session", "custom-session")
	h6 := Headers(candOf(override, "m1", "chat"), HeaderOpts{Stream: true, ClientHeaders: map[string]any{}, Session: "nomi:h:s1"})
	if h6.Has("x-opencode-session") {
		t.Fatalf("duplicate lowercase session header when Provider.Headers defines X-Opencode-Session: %s", u.Stringify(h6))
	}
	if got := h6.Get("X-Opencode-Session"); got != "custom-session" {
		t.Fatalf("custom X-Opencode-Session = %v", got)
	}
}
