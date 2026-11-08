package tools

import (
	"strconv"
	"testing"
)

func TestStickyKeepsWhatWasOpened(t *testing.T) {
	resetSticky()
	if Sticky("c1", "browser_open", false) {
		t.Fatal("never opened")
	}
	if !Sticky("c1", "browser_open", true) || !Sticky("c1", "browser_open", false) {
		t.Fatal("opened once must stay open")
	}
	// 别的对话、别的工具不受影响
	if Sticky("c2", "browser_open", false) || Sticky("c1", "code_run", false) {
		t.Fatal("leaked")
	}
	// 没有对话 id：只看这一轮
	if Sticky("", "browser_open", false) {
		t.Fatal("no conversation id")
	}
}

func TestStickyEvictsOldConversations(t *testing.T) {
	resetSticky()
	Sticky("old", "x", true)
	for i := 0; i < StickyMaxConversations; i++ {
		Sticky("c"+strconv.Itoa(i), "x", true)
	}
	if Sticky("old", "x", false) {
		t.Fatal("oldest conversation not evicted")
	}
	if !Sticky("c"+strconv.Itoa(StickyMaxConversations-1), "x", false) {
		t.Fatal("recent conversation evicted")
	}
}
