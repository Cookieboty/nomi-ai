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

// 一直用同一个会话（没有新 id）：落盘的「最后见到」也往前走，首次登记超过 30 天、最近还在用的，关掉标签重启后仍认得（#315）
func TestOwnedLastSeenPersistsWithoutNewIDs(t *testing.T) {
	dir := t.TempDir()
	now := float64(1_000_000)
	clock := func() float64 { return now }
	tab := []*util.Obj{util.NewObj("backend", "claude", "cliSessionId", "s1")}
	s := New(Deps{Root: dir, Now: clock})
	s.rememberOwned(tab)
	// 第 1 到 40 天每天都还在用同一个会话
	for day := 1; day <= 40; day++ {
		now += 24 * 3600 * 1000
		s.rememberOwned(tab)
	}
	s.rememberOwned(nil) // 标签关掉
	if !New(Deps{Root: dir, Now: clock}).ownedBy("claude:s1") {
		t.Fatal("a session still used within ownedKeepMs stays Nomi's after a restart")
	}
	// 之后真的 30 天没再见到：丢掉
	now += ownedKeepMs
	if New(Deps{Root: dir, Now: clock}).ownedBy("claude:s1") {
		t.Fatal("forgotten after ownedKeepMs without being seen")
	}
}

// 老 id 的「最后见到」按 ownedFlushMs 节流写盘，不是每次观测都写
func TestOwnedLastSeenFlushIsThrottled(t *testing.T) {
	dir := t.TempDir()
	now := float64(1_000_000)
	s := New(Deps{Root: dir, Now: func() float64 { return now }})
	tab := []*util.Obj{util.NewObj("backend", "claude", "cliSessionId", "s1")}
	s.rememberOwned(tab)
	first := s.ownedSavedAt
	now += 60 * 1000
	s.rememberOwned(tab)
	if s.ownedSavedAt != first {
		t.Fatal("no write within ownedFlushMs when nothing is new")
	}
	now += ownedFlushMs
	s.rememberOwned(tab)
	if s.ownedSavedAt != now {
		t.Fatal("written once ownedFlushMs has passed")
	}
}
