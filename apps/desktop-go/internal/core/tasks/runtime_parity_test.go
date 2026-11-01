package tasks

// golden：scripts/parity/record-tasks-runtime.mjs（与 tests/unit/tasks/runtimeHarness.ts 对应的内存存储、假时钟、假执行者）

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// ---------- 测试环境（对应 runtimeHarness.ts） ----------

type memStore struct {
	recs     map[string]Record
	journals map[string][]JournalEntry
}

func newMemStore() *memStore {
	return &memStore{recs: map[string]Record{}, journals: map[string][]JournalEntry{}}
}

func cloneJSON[T any](v T) T {
	b, _ := json.Marshal(v)
	var out T
	_ = json.Unmarshal(b, &out)
	return out
}

func (m *memStore) LoadAll() []Record {
	ids := make([]string, 0, len(m.recs))
	for id := range m.recs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := []Record{}
	for _, id := range ids {
		out = append(out, cloneJSON(m.recs[id]))
	}
	return out
}

func (m *memStore) Save(r Record) (Record, error) {
	if len(r.Attempts) > 50 {
		r.Attempts = r.Attempts[len(r.Attempts)-50:]
	}
	if r.Attempts == nil {
		r.Attempts = []Attempt{}
	}
	c := cloneJSON(r)
	m.recs[r.Task.ID] = c
	return cloneJSON(c), nil
}

func (m *memStore) Append(id string, e JournalEntry) error {
	m.journals[id] = append(m.journals[id], cloneJSON(e))
	return nil
}

func (m *memStore) UnconfirmedExternal(id, attemptID string) bool {
	open := map[int]bool{}
	for _, e := range m.journals[id] {
		if e.AttemptID != attemptID || e.Seq == nil {
			continue
		}
		if e.T == "intent" {
			open[*e.Seq] = true
		}
		if e.T == "done" {
			delete(open, *e.Seq)
		}
	}
	return len(open) > 0
}

func (m *memStore) Remove(id string) error {
	delete(m.recs, id)
	delete(m.journals, id)
	return nil
}

type fakeTimer struct {
	at   int64
	fn   func()
	seq  int
	live bool
}

type fakeClock struct {
	t      int64
	timers []*fakeTimer
	seq    int
}

func (c *fakeClock) Now() int64 { return c.t }

func (c *fakeClock) SetTimer(fn func(), ms int64) func() {
	tm := &fakeTimer{at: c.t + ms, fn: fn, seq: c.seq, live: true}
	c.seq++
	c.timers = append(c.timers, tm)
	return func() { tm.live = false }
}

func (c *fakeClock) Advance(ms int64) {
	end := c.t + ms
	for {
		var due *fakeTimer
		live := c.timers[:0]
		for _, tm := range c.timers {
			if tm.live {
				live = append(live, tm)
			}
		}
		c.timers = live
		for _, tm := range c.timers {
			if tm.at <= end && (due == nil || tm.at < due.at || (tm.at == due.at && tm.seq < due.seq)) {
				due = tm
			}
		}
		if due == nil {
			break
		}
		due.live = false
		if due.at > c.t {
			c.t = due.at
		}
		due.fn()
	}
	c.t = end
}

type fakeExec struct {
	calls     []map[string]any
	reporters map[string]Reporter
	prepErr   map[string]TaskError
}

func (f *fakeExec) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	if e, ok := f.prepErr[t.ID]; ok {
		return ExecutionSnapshot{}, &e
	}
	return ExecutionSnapshot{GrantVersion: t.Grant.Version, Model: ptr("m")}, nil
}

func (f *fakeExec) Start(ctx AttemptContext) {
	f.calls = append(f.calls, map[string]any{"op": "start", "taskId": ctx.Task.ID, "gen": ctx.Attempt.Gen,
		"attemptId": ctx.Attempt.ID, "cause": ctx.Attempt.Cause})
	f.reporters[ctx.Task.ID] = ctx.Report
}

func (f *fakeExec) Resume(id string, gen int, a Answer) {
	f.calls = append(f.calls, map[string]any{"op": "resume", "taskId": id, "gen": gen, "answer": a})
}

func (f *fakeExec) Stop(id string, gen int, reason string) {
	f.calls = append(f.calls, map[string]any{"op": "stop", "taskId": id, "gen": gen, "reason": reason})
}

// ---------- 重放 ----------

type rtOp struct {
	Op        string          `json:"op"`
	Input     *CreateInput    `json:"input"`
	Task      string          `json:"task"`
	Cmd       *Command        `json:"cmd"`
	Ms        int64           `json:"ms"`
	Kind      string          `json:"kind"`
	Arg       json.RawMessage `json:"arg"`
	Error     *TaskError      `json:"error"`
	AttemptID string          `json:"attemptId"`
}

type rtStep struct {
	Op        json.RawMessage `json:"op"`
	Result    json.RawMessage `json:"result"`
	Calls     json.RawMessage `json:"calls"`
	Delivered json.RawMessage `json:"delivered"`
}

type rtScenario struct {
	Name          string                     `json:"name"`
	MaxConcurrent int                        `json:"maxConcurrent"`
	Ops           []rtOp                     `json:"ops"`
	Steps         []rtStep                   `json:"steps"`
	Records       json.RawMessage            `json:"records"`
	Journals      map[string]json.RawMessage `json:"journals"`
	Slots         []string                   `json:"slots"`
}

type delivery struct {
	TaskID    string `json:"taskId"`
	What      string `json:"what"`
	AttemptID string `json:"attemptId,omitempty"`
}

func TestRuntimeParity(t *testing.T) {
	gp, _ := paritytest.Golden(t, "tasks-runtime.json", filepath.Join("testdata", "tasks-runtime.json"))
	b, err := os.ReadFile(gp)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		T0        int64        `json:"T0"`
		Scenarios []rtScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) { replay(t, g.T0, sc) })
	}
}

func replay(t *testing.T, t0 int64, sc rtScenario) {
	store := newMemStore()
	ids := 0
	var clock *fakeClock
	var exec *fakeExec
	var rt *Runtime
	var delivered []delivery
	boot := func(at int64) {
		clock = &fakeClock{t: at}
		exec = &fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}
		delivered = []delivery{}
		rt = NewRuntime(RuntimeDeps{
			Store:     store,
			Executors: map[string]Executor{"nomi": exec, "notify": exec, "cli": exec},
			Now:       clock.Now,
			SetTimer:  clock.SetTimer,
			NewID: func(p string) string {
				ids++
				return fmt.Sprintf("%s_%d", p, ids)
			},
			Log: &nopLog{},
			Deliver: func(task Task, what string, a *Attempt) {
				d := delivery{TaskID: task.ID, What: what}
				if a != nil {
					d.AttemptID = a.ID
				}
				delivered = append(delivered, d)
			},
			MaxConcurrent:      sc.MaxConcurrent,
			HeartbeatTimeoutMs: 5 * 60_000,
		})
	}
	boot(t0)
	for i, op := range sc.Ops {
		want := sc.Steps[i]
		callsBefore, delBefore := len(exec.calls), len(delivered)
		var result any
		switch op.Op {
		case "start":
			rt.Start()
		case "create":
			result = rt.Create(*op.Input).ID
		case "cmd":
			result = rt.Command(op.Task, *op.Cmd)
		case "advance":
			clock.Advance(op.Ms)
		case "report":
			rep := exec.reporters[op.Task]
			switch op.Kind {
			case "heartbeat":
				rep.Heartbeat()
			case "takenOver":
				rep.TakenOver()
			case "completed":
				var r AttemptResult
				_ = json.Unmarshal(op.Arg, &r)
				rep.Completed(r)
			case "failed":
				var e TaskError
				_ = json.Unmarshal(op.Arg, &e)
				rep.Failed(e)
			case "needsUser":
				var w EventWait
				_ = json.Unmarshal(op.Arg, &w)
				rep.NeedsUser(w)
			case "usage":
				var d UsageDelta
				_ = json.Unmarshal(op.Arg, &d)
				rep.Usage(d)
			default:
				t.Fatalf("unknown report %s", op.Kind)
			}
		case "prepareError":
			if op.Error != nil {
				exec.prepErr[op.Task] = *op.Error
			} else {
				delete(exec.prepErr, op.Task)
			}
		case "intent":
			_ = store.Append(op.Task, JournalEntry{T: "intent", At: clock.Now(), AttemptID: op.AttemptID, Seq: ptr(1), Action: "x", Hash: "h"})
		case "restart":
			rt.Stop()
			boot(clock.Now() + op.Ms)
			rt.Start()
			callsBefore, delBefore = 0, 0
		case "remove":
			result = rt.Remove(op.Task)
		default:
			t.Fatalf("unknown op %s", op.Op)
		}
		label := fmt.Sprintf("step %d %s", i, string(want.Op))
		calls := exec.calls[callsBefore:]
		if calls == nil {
			calls = []map[string]any{}
		}
		eqJSON(t, label+" calls", calls, want.Calls)
		eqJSON(t, label+" delivered", delivered[delBefore:], want.Delivered)
		if want.Result != nil {
			eqJSON(t, label+" result", result, want.Result)
		}
	}
	eqJSON(t, "records", store.LoadAll(), sc.Records)
	for id, j := range sc.Journals {
		eqJSON(t, "journal "+id, store.journals[id], j)
	}
	if got := rt.SlotHolders(); fmt.Sprint(got) != fmt.Sprint(sc.Slots) {
		t.Fatalf("slots go=%v node=%v", got, sc.Slots)
	}
}
