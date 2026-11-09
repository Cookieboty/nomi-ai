package tasks

import (
	"context"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
)

// 首启迁移：只记了目录的 Nomi 任务补上项目；已经有项目的不动
func TestAdoptProjects(t *testing.T) {
	h := newConvHarness(t, nil, func(context.Context, func(blm.ChatChunk)) error { return nil })
	old := conversationExecutor()
	id := h.rt.Create(CreateInput{Title: "旧任务", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Origin: Origin{CreatedBy: "nomi", CreatedAt: 1}, Executor: ExecutorSpec{Kind: "nomi", Tools: old.Tools, Toolset: old.Toolset, Cwd: sp("/work/deck"), Brief: old.Brief}, Grant: Grant{Level: 3}}).ID
	done := h.rt.Create(CreateInput{Title: "新任务", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Origin: Origin{CreatedBy: "nomi", CreatedAt: 1}, Executor: old, Grant: Grant{Level: 3}}).ID
	if got := h.rt.ProjectCwds(); len(got) != 1 || got[0] != "/work/deck" {
		t.Fatalf("cwds = %v", got)
	}
	if n := h.rt.AdoptProjects(map[string]string{"/work/deck": "p_new"}); n != 1 {
		t.Fatalf("adopted %d", n)
	}
	if p := h.rt.Get(id).Task.Executor.Project; p == nil || *p != "p_new" {
		t.Fatalf("project = %v", p)
	}
	if p := h.rt.Get(done).Task.Executor.Project; p == nil || *p != "p_deck" {
		t.Fatal("tasks that already have a project are left alone")
	}
}
