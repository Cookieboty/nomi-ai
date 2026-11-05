package tasks

// 测试辅助

import (
	"encoding/json"
	"sort"
	"testing"
)

func raw(t *testing.T, m json.RawMessage) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(m, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

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

type nopLog struct{ n int }

func (l *nopLog) Warn(string, ...any) { l.n++ }
