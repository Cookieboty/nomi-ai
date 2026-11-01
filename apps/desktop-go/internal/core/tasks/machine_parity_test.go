package tasks

// golden：scripts/parity/record-tasks-machine.mjs（遍历：起始状态 × 全部事件，只记最后一步；长链逐步记）

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type scenario struct {
	Name   string            `json:"name"`
	Task   Task              `json:"task"`
	Events []Event           `json:"events"`
	Last   json.RawMessage   `json:"last"`
	Steps  []json.RawMessage `json:"steps"`
}

// canon：Go 结果转成与 golden 同样的通用 JSON 结构再比
func canon(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func raw(t *testing.T, m json.RawMessage) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(m, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestMachineParity(t *testing.T) {
	gp, _ := paritytest.Golden(t, "tasks-machine.json", filepath.Join("testdata", "tasks-machine.json"))
	b, err := os.ReadFile(gp)
	if err != nil {
		t.Fatal(err)
	}
	var g struct{ Scenarios []scenario }
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) < 800 {
		t.Fatalf("golden has only %d scenarios", len(g.Scenarios))
	}
	for _, sc := range g.Scenarios {
		task, attempt := sc.Task, (*Attempt)(nil)
		var last Result
		for i, ev := range sc.Events {
			r := Transition(task, attempt, ev)
			if sc.Steps != nil {
				if got, want := canon(t, r), raw(t, sc.Steps[i]); !reflect.DeepEqual(got, want) {
					t.Fatalf("%s step %d (%s):\n go:   %v\n node: %v", sc.Name, i, ev.Type, got, want)
				}
			} else if i < len(sc.Events)-1 && !r.OK {
				t.Fatalf("%s: prefix step %d (%s) rejected: %s", sc.Name, i, ev.Type, r.Reason)
			}
			task, attempt, last = r.Task, r.Attempt, r
		}
		if sc.Steps == nil {
			if got, want := canon(t, last), raw(t, sc.Last); !reflect.DeepEqual(got, want) {
				t.Fatalf("%s:\n go:   %v\n node: %v", sc.Name, got, want)
			}
		}
	}
}

// 输入不被修改：Transition 之后原任务序列化结果不变
func TestTransitionDoesNotMutateInput(t *testing.T) {
	task := Task{
		ID: "task_1", Status: StatusRunning, Enabled: true, Gen: 1, Acceptance: "auto",
		Trigger: Trigger{Kind: "manual"}, Grant: Grant{Version: 1, Paths: []string{}, Connections: []ConnectionGrant{}},
		Wait: nil, LastAttemptID: ptr("att_1"),
	}
	a := &Attempt{ID: "att_1", TaskID: "task_1", Gen: 1, Status: "running"}
	before, _ := json.Marshal(struct {
		T Task
		A *Attempt
	}{task, a})
	for _, ev := range []Event{
		{Type: "cancel", At: 5},
		{Type: "grant_revoked", At: 5},
		{Type: "needs_user", At: 5, Gen: ptr(1), Wait: &EventWait{Kind: "approval"}},
		{Type: "failed", At: 5, Gen: ptr(1), Error: &TaskError{Code: "network"}},
		{Type: "restarted", At: 5},
	} {
		Transition(task, a, ev)
	}
	after, _ := json.Marshal(struct {
		T Task
		A *Attempt
	}{task, a})
	if string(before) != string(after) {
		t.Fatalf("input mutated:\n%s\n%s", before, after)
	}
}

func TestRetryBackoff(t *testing.T) {
	want := []int64{2000, 4000, 8000, 16000, 32000, 60000, 60000}
	for i, w := range want {
		if got := RetryBackoffMs(i + 1); got != w {
			t.Fatalf("RetryBackoffMs(%d) = %d, want %d", i+1, got, w)
		}
	}
}
