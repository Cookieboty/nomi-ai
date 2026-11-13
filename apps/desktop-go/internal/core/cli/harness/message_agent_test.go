package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
)

func TestAcceptCodexAgentThread(t *testing.T) {
	d := &drivers.AppServerDriver{}
	main := "th-main"
	d.ThreadID = &main

	if acceptCodexAgentThread(nil, "c1") {
		t.Fatal("nil driver")
	}
	if acceptCodexAgentThread(d, "") {
		t.Fatal("empty")
	}
	if acceptCodexAgentThread(d, "th-main") {
		t.Fatal("main thread")
	}
	if acceptCodexAgentThread(d, "spoof") {
		t.Fatal("undiscovered")
	}

	d.NoteChild("c1", "call1")
	if !acceptCodexAgentThread(d, "c1") {
		t.Fatal("discovered child")
	}
	d.SetFork("c1", "f1")
	if !acceptCodexAgentThread(d, "f1") {
		t.Fatal("fork of discovered child")
	}
	if !acceptCodexAgentThread(d, "c1") {
		t.Fatal("original after fork")
	}

	// 另一个标签（另一个 driver）上的同一 id 不能通过
	other := &drivers.AppServerDriver{}
	oid := "th-other"
	other.ThreadID = &oid
	if acceptCodexAgentThread(other, "c1") {
		t.Fatal("other tab")
	}
	// 即便把主线程 id 写成子代理的样子，也必须拒绝
	if acceptCodexAgentThread(d, "th-main") {
		t.Fatal("main still rejected after children exist")
	}
}
