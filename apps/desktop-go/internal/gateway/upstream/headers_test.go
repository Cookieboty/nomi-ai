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
}
