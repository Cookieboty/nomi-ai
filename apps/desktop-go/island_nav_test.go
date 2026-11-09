package main

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

// 灵动岛条目 → 对话窗口里的去处
func TestIslandNavOf(t *testing.T) {
	for id, want := range map[string][2]string{
		"perm\x1ftab_3\x1freq9": {"tab", "tab_3"},
		"sbx\x1ftab_1\x1fs2":    {"tab", "tab_1"},
		"task\x1ftk_7":          {"task", "tk_7"},
		"confirm\x1fc1":         {"nomi", ""},
	} {
		if tg, ref := islandNavOf(id); tg != want[0] || ref != want[1] {
			t.Errorf("%q → %s %s", id, tg, ref)
		}
	}
}

// 对话里委派出去、结果已回报到来源对话的「等你验收」：归对话处理，不上岛；没回报过、不是对话委派的照常上岛
func TestIslandConversationOwns(t *testing.T) {
	svc := tasks.NewService(tasks.ServiceDeps{Root: t.TempDir(), Log: islandNopLog{}, Notify: func(string, string) {}})
	created := svc.Runtime.Create(tasks.CreateInput{Title: "t", Goal: "g", Trigger: tasks.Trigger{Kind: "manual"},
		Executor: tasks.ExecutorSpec{Kind: "notify"}, Grant: tasks.Grant{Paths: []string{}, Connections: []tasks.ConnectionGrant{}}})
	via, conv, att := "delegate", "c1", "a1"
	task := created
	task.Status = tasks.StatusAwaitingAccept
	task.Origin = tasks.Origin{ConversationID: &conv, Via: &via}
	task.LastAttemptID = &att
	if svc.ConversationOwns(task) {
		t.Fatal("not announced yet: should stay on the island")
	}
	svc.MarkAnnounced(task.ID, att)
	if !svc.ConversationOwns(task) {
		t.Fatal("announced to its conversation: the conversation owns it")
	}
	user := task
	user.Origin = tasks.Origin{}
	if svc.ConversationOwns(user) {
		t.Fatal("a task the user created stays on the island")
	}
	running := task
	running.Status = tasks.StatusWaitingUser
	if svc.ConversationOwns(running) {
		t.Fatal("waiting for the user (approval) stays on the island")
	}
}

type islandNopLog struct{}

func (islandNopLog) Info(string, ...any) {}
func (islandNopLog) Warn(string, ...any) {}

// 同一个任务换了一次等待（p1 → p2、代次变了）就是另一条：岛上晚到的旧按钮查不到新等待的处理函数（#293）
func TestIslandTaskItemIDTracksTheWait(t *testing.T) {
	p1, p2 := "p1", "p2"
	a := tasks.Task{ID: "tk_7", Gen: 4, Status: tasks.StatusWaitingUser, Wait: &tasks.Wait{Kind: "approval", RequestID: &p1}}
	b := a
	b.Wait = &tasks.Wait{Kind: "approval", RequestID: &p2}
	c := a
	c.Gen = 5
	ids := map[string]bool{islandTaskItemID(a): true, islandTaskItemID(b): true, islandTaskItemID(c): true}
	if len(ids) != 3 {
		t.Fatalf("ids collide: %v", ids)
	}
	for id := range ids {
		if tg, ref := islandNavOf(id); tg != "task" || ref != "tk_7" {
			t.Errorf("%q → %s %s", id, tg, ref)
		}
	}
	if islandTaskItemID(a) != islandTaskItemID(a) {
		t.Fatal("the same wait must keep its id across refreshes")
	}
}
