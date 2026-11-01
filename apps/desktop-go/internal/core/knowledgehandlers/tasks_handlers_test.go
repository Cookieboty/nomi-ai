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
