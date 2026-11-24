package knowledgehandlers

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

type nopLog struct{}

func (nopLog) Info(string, ...any) {}
func (nopLog) Warn(string, ...any) {}

func TestTaskHandlersRoundTrip(t *testing.T) {
	svc := tasks.NewService(tasks.ServiceDeps{Root: t.TempDir(), Log: nopLog{}, Notify: func(string, string) {}})
	svc.Start()
	hs := taskHandlers(Services{Tasks: func() *tasks.Service { return svc }})
	call := func(name, in string) any {
		v, err := hs[name](context.Background(), json.RawMessage(in))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return v
	}
	created := call("tasks.create", `{"title":"t","goal":"g","trigger":{"kind":"manual"},
		"executor":{"kind":"notify","text":"hi"},"grant":{"level":0,"paths":[],"connections":[]}}`).(tasks.Task)
	id := created.ID
	if r := call("tasks.runNow", `{"id":"`+id+`"}`).(tasks.CmdResult); !r.OK {
		t.Fatal(r)
	}
	rec := call("tasks.get", `{"id":"`+id+`"}`).(*tasks.Record)
	if rec.Task.Status != tasks.StatusDone || rec.Task.Grant.Version != 1 {
		t.Fatalf("%+v", rec.Task)
	}
	if r := call("tasks.decide", `{"id":"`+id+`","approve":true}`).(tasks.CmdResult); r.OK || r.Reason != "illegal" {
		t.Fatal(r)
	}
	if r := call("tasks.archive", `{"id":"`+id+`"}`).(tasks.CmdResult); !r.OK {
		t.Fatal(r)
	}
	if r := call("tasks.unarchive", `{"id":"`+id+`"}`).(tasks.CmdResult); !r.OK {
		t.Fatal(r)
	}
	resArch := call("tasks.archiveAllEnded", `null`).(map[string]int)
	if resArch["archived"] != 1 {
		t.Fatalf("expected archived=1, got %+v", resArch)
	}
	if !call("tasks.remove", `{"id":"`+id+`"}`).(bool) {
		t.Fatal("remove")
	}

	// 验证 tasks.update(goal/doneWhen/acceptance), tasks.appendQueued, tasks.followUp(updateGoal), tasks.handoffFromChat
	abortedReq := ""
	gate := make(chan struct{})
	stub := &slowStubExec{gate: gate}
	svc.RegisterExecutor("nomi", stub)
	t.Cleanup(func() {
		close(gate)
		stub.wg.Wait()
	})
	hsExt := taskHandlers(Services{
		Tasks:        func() *tasks.Service { return svc },
		AbortChatReq: func(reqID string) { abortedReq = reqID },
		ResolveWorkspace: func(projectID any) (string, []string) {
			if projectID == "proj_1" {
				return "/repo", []string{"/repo"}
			}
			return "", nil
		},
	})
	svc.Runtime.SetMaxConcurrent(1)
	tBusy := call("tasks.create", `{"title":"busy","goal":"g","trigger":{"kind":"manual"},
		"executor":{"kind":"nomi","tools":["read"]},"grant":{"level":1,"paths":[],"connections":[]}}`).(tasks.Task)
	call("tasks.runNow", `{"id":"`+tBusy.ID+`"}`)
	tQueued := call("tasks.create", `{"title":"q","goal":"orig goal","trigger":{"kind":"manual"},
		"executor":{"kind":"nomi","tools":["read"]},"grant":{"level":1,"paths":[],"connections":[]}}`).(tasks.Task)
	call("tasks.runNow", `{"id":"`+tQueued.ID+`"}`)
	rApp, err := hsExt["tasks.appendQueued"](context.Background(), json.RawMessage(`{"id":"`+tQueued.ID+`","text":"加一条说明"}`))
	if err != nil || !rApp.(tasks.CmdResult).OK {
		t.Fatalf("appendQueued failed: %+v err=%v", rApp, err)
	}
	uVal, err := hsExt["tasks.update"](context.Background(), json.RawMessage(`{"id":"`+tQueued.ID+`","goal":"new goal","doneWhen":"done text","acceptance":"auto"}`))
	if err != nil || uVal.(*tasks.Task).Goal != "new goal" || uVal.(*tasks.Task).Acceptance != "auto" {
		t.Fatalf("update goal/doneWhen/acceptance failed: %+v err=%v", uVal, err)
	}
	hVal, err := hsExt["tasks.handoffFromChat"](context.Background(), json.RawMessage(`{"reqId":"req_1","conversationId":"conv_9","projectId":"proj_1","userGoal":"帮我查全仓问题","partialContent":"已查了一半"}`))
	if err != nil || abortedReq != "req_1" {
		t.Fatalf("handoffFromChat failed: err=%v aborted=%q", err, abortedReq)
	}
	ht := hVal.(tasks.Task)
	if ht.Origin.Via == nil || *ht.Origin.Via != "handoff" || ht.Executor.Cwd == nil || *ht.Executor.Cwd != "/repo" {
		t.Fatalf("unexpected handoff task: %+v", ht)
	}
	if _, err := hs["tasks.update"](context.Background(), json.RawMessage(`{"id":"task_x","title":"y"}`)); err == nil ||
		err.(*contract.Error).Code != "TASKS_NOT_FOUND" {
		t.Fatal(err)
	}
	if v, err := taskHandlers(Services{})["tasks.list"](context.Background(), nil); v != nil || err.(*contract.Error).Code != "UNAVAILABLE" {
		t.Fatal(err)
	}
}

func TestTaskHandlersEvents(t *testing.T) {
	svc := tasks.NewService(tasks.ServiceDeps{Root: t.TempDir(), Log: nopLog{}, Notify: func(string, string) {}})
	svc.RegisterSource(tasks.NewWebSource(tasks.WebSourceDeps{}))
	svc.Start()
	defer svc.Stop()
	hs := taskHandlers(Services{Tasks: func() *tasks.Service { return svc }})
	_, err := hs["tasks.create"](context.Background(), json.RawMessage(`{"title":"t","goal":"g",
		"trigger":{"kind":"event","sourceId":"web","filter":{},"mode":"observe"},
		"executor":{"kind":"notify","text":"hi"},"grant":{"level":0,"paths":[],"connections":[]}}`))
	if ce, ok := err.(*contract.Error); !ok || ce.Code != "TASKS_BAD_TRIGGER" {
		t.Fatal(err)
	}
	v, err := hs["tasks.create"](context.Background(), json.RawMessage(`{"title":"t","goal":"g",
		"trigger":{"kind":"event","sourceId":"web","filter":{"url":"https://example.com/"},"mode":"observe"},
		"executor":{"kind":"notify","text":"hi"},"grant":{"level":0,"paths":[],"connections":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	id := v.(tasks.Task).ID
	ev, err := hs["tasks.events"](context.Background(), json.RawMessage(`{"id":"`+id+`"}`))
	b, _ := json.Marshal(ev)
	if err != nil || string(b) != `{"observed":[],"sources":["web"]}` {
		t.Fatal(err, string(b))
	}
	if r, _ := hs["tasks.processObserved"](context.Background(), json.RawMessage(`{"id":"`+id+`"}`)); r.(tasks.CmdResult).Reason != "empty" {
		t.Fatal(r)
	}
	if r, _ := hs["tasks.clearObserved"](context.Background(), json.RawMessage(`{"id":"`+id+`"}`)); r != true {
		t.Fatal(r)
	}
	m, err := hs["tasks.setMode"](context.Background(), json.RawMessage(`{"id":"`+id+`","mode":"act"}`))
	if err != nil || *m.(*tasks.Task).Trigger.Mode != "act" {
		t.Fatal(err, m)
	}
}

// 授权里的连接能力不合法：tasks.create / tasks.grant 都映射成 TASKS_BAD_GRANT
func TestTaskHandlersBadGrant(t *testing.T) {
	svc := tasks.NewService(tasks.ServiceDeps{Root: t.TempDir(), Log: nopLog{}, Notify: func(string, string) {}})
	svc.Start()
	defer svc.Stop()
	hs := taskHandlers(Services{Tasks: func() *tasks.Service { return svc }})
	_, err := hs["tasks.create"](context.Background(), json.RawMessage(`{"title":"t","goal":"g","trigger":{"kind":"manual"},
		"executor":{"kind":"nomi","tools":["read"]},"grant":{"level":3,"paths":[],
		"connections":[{"connectionId":"conn_1","capabilities":["github.comment"],"resources":["o/r"]}]}}`))
	if ce, ok := err.(*contract.Error); !ok || ce.Code != "TASKS_BAD_GRANT" {
		t.Fatal(err)
	}
	v, err := hs["tasks.create"](context.Background(), json.RawMessage(`{"title":"t","goal":"g","trigger":{"kind":"manual"},
		"executor":{"kind":"nomi","tools":["read"]},"grant":{"level":1,"paths":[],"connections":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	id := v.(tasks.Task).ID
	_, err = hs["tasks.grant"](context.Background(), json.RawMessage(`{"id":"`+id+`","grant":{"level":4,"paths":[],
		"connections":[{"connectionId":"conn_1","capabilities":["github.merge"],"resources":["o/r"]}]}}`))
	if ce, ok := err.(*contract.Error); !ok || ce.Code != "TASKS_BAD_GRANT" {
		t.Fatal(err)
	}
}

type slowStubExec struct {
	gate chan struct{}
	wg   sync.WaitGroup
}

func (e *slowStubExec) Prepare(t tasks.Task) (tasks.ExecutionSnapshot, *tasks.TaskError) {
	return tasks.ExecutionSnapshot{GrantVersion: t.Grant.Version}, nil
}

func (e *slowStubExec) Start(ctx tasks.AttemptContext) {
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		<-e.gate
		ctx.Report.Completed(tasks.AttemptResult{Summary: "ok"})
	}()
}

func (e *slowStubExec) Resume(string, int, tasks.Answer) {}

func (e *slowStubExec) Stop(string, int, string) {}

func TestTaskHandlersUpdateModel(t *testing.T) {
	svc := tasks.NewService(tasks.ServiceDeps{Root: t.TempDir(), Log: nopLog{}, Notify: func(string, string) {}})
	svc.Start()
	defer svc.Stop()
	hs := taskHandlers(Services{Tasks: func() *tasks.Service { return svc }})
	v, err := hs["tasks.create"](context.Background(), json.RawMessage(`{"title":"t","goal":"g","trigger":{"kind":"manual"},
		"executor":{"kind":"nomi","tools":["read"]},"grant":{"level":1,"paths":[],"connections":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	id := v.(tasks.Task).ID

	uVal, err := hs["tasks.update"](context.Background(), json.RawMessage(`{"id":"`+id+`","model":"openai/gpt-5.4","reasoningEffort":"high"}`))
	if err != nil {
		t.Fatalf("tasks.update valid model failed: %v", err)
	}
	ut := uVal.(*tasks.Task)
	if ut.Executor.Model == nil || *ut.Executor.Model != "openai/gpt-5.4" ||
		ut.Executor.ReasoningEffort == nil || *ut.Executor.ReasoningEffort != "high" {
		t.Fatalf("unexpected executor after update: %+v", ut.Executor)
	}

	if _, err := hs["tasks.update"](context.Background(), json.RawMessage(`{"id":"`+id+`","model":"not-a-ref"}`)); err == nil {
		t.Fatal("expected BAD_INPUT for invalid model ref")
	} else if ce, ok := err.(*contract.Error); !ok || ce.Code != "BAD_INPUT" {
		t.Fatalf("expected BAD_INPUT, got %#v", err)
	}
}
