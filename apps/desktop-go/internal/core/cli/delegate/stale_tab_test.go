package delegate

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 出错 / 被停下的委派标签不再 15 分钟就自动关：和正常完成的一样闲置一周才关，用户可以一直在里面接着回复。
func TestErroredDelegatedTabStaysOpenLikeOthers(t *testing.T) {
	const now = float64(10 * StaleDelegatedTabMs)
	tab := func(idleMs float64, del *util.Obj) *util.Obj {
		return util.NewObj("id", "t", "status", "idle", "updatedAt", now-idleMs, "delegation", del)
	}
	errored := func() *util.Obj { return util.NewObj("by", "nomi", "taskId", "A", "lastError", true) }
	ok := func() *util.Obj { return util.NewObj("by", "nomi", "taskId", "A") }

	for _, idle := range []float64{20 * 60_000, 2 * 60 * 60_000, StaleDelegatedTabMs - 1} {
		if DelegatedTabExpired(tab(idle, errored()), now) {
			t.Fatalf("errored tab idle %vms must stay open", idle)
		}
		if DelegatedTabExpired(tab(idle, ok()), now) {
			t.Fatalf("done tab idle %vms must stay open", idle)
		}
	}
	if !DelegatedTabExpired(tab(StaleDelegatedTabMs, errored()), now) || !DelegatedTabExpired(tab(StaleDelegatedTabMs, ok()), now) {
		t.Fatal("tabs idle a full week should be closable")
	}
	// 被用户接手的、不是 Nomi 委派的、还在跑的：永远不自动关
	taken := errored()
	taken.Set("takenOver", true)
	if DelegatedTabExpired(tab(2*StaleDelegatedTabMs, taken), now) {
		t.Fatal("taken-over tab must not be closed")
	}
	if DelegatedTabExpired(tab(2*StaleDelegatedTabMs, util.NewObj("by", "user")), now) {
		t.Fatal("non-nomi tab must not be closed")
	}
	running := tab(2*StaleDelegatedTabMs, errored())
	running.Set("status", "running")
	if DelegatedTabExpired(running, now) || DelegatedTabExpired(nil, now) {
		t.Fatal("running / nil tab must not be closed")
	}
}
