package knowledgehandlers

import (
	"context"
	"encoding/json"
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
	if !call("tasks.remove", `{"id":"`+id+`"}`).(bool) {
		t.Fatal("remove")
	}
	if _, err := hs["tasks.update"](context.Background(), json.RawMessage(`{"id":"task_x","title":"y"}`)); err == nil ||
		err.(*contract.Error).Code != "TASKS_NOT_FOUND" {
		t.Fatal(err)
	}
	if v, err := taskHandlers(Services{})["tasks.list"](context.Background(), nil); v != nil || err.(*contract.Error).Code != "UNAVAILABLE" {
		t.Fatal(err)
	}
}
