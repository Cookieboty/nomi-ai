package agents

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Nomi 标签用过的会话：标签关掉、会话 id 换掉之后仍认得；重开应用后也认得；太久没见的丢掉
func TestOwnedSessionsOutliveTheTab(t *testing.T) {
	dir := t.TempDir()
	now := float64(1_000_000)
	s := New(Deps{Root: dir, Now: func() float64 { return now }})
	s.rememberOwned([]*util.Obj{util.NewObj("backend", "claude", "cliSessionId", "s1")})
	// 标签换了会话（出错重开），之后关掉
	s.rememberOwned([]*util.Obj{util.NewObj("backend", "claude", "cliSessionId", "s2")})
	s.rememberOwned(nil)
	if !s.ownedBy("claude:s1") || !s.ownedBy("claude:s2") {
		t.Fatal("sessions a Nomi tab used stay Nomi's after the tab is gone")
	}
	if s.ownedBy("codex:s1") {
		t.Fatal("other backends are not owned")
	}
	again := New(Deps{Root: dir, Now: func() float64 { return now }})
	if !again.ownedBy("claude:s2") {
		t.Fatal("remembered across restarts")
	}
	later := New(Deps{Root: dir, Now: func() float64 { return now + ownedKeepMs }})
	if later.ownedBy("claude:s1") {
		t.Fatal("forgotten after ownedKeepMs")
	}
}
