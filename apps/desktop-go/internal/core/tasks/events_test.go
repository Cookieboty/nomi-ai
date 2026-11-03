package tasks

// 对应 tests/unit/tasks/events.test.ts：EventHub 语义与四个事件源。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

var evT0 = time.Date(2026, 11, 2, 1, 0, 0, 0, time.UTC).UnixMilli()

func sev(key string, at int64) SourceEvent {
	return SourceEvent{Key: key, OccurredAt: at, Summary: key, Payload: map[string]any{"key": key}}
}

func evTask(mode string, cooldown int64) Task {
	src := "fake"
	return Task{ID: "task_1", Title: "t", Goal: "g", Status: StatusIdle, Enabled: true,
		Trigger: Trigger{Kind: "event", SourceID: &src, Filter: json.RawMessage(`{}`), Mode: &mode, CooldownMs: &cooldown},
		Grant:   Grant{Version: 1, Level: 1, Paths: []string{}, Connections: []ConnectionGrant{}}}
}

type hubHarness struct {
	hub     *EventHub
	queue   *[][]SourceEvent
	fired   *[][2]string
	changed *[]string
	root    string
	now     *int64
	busy    *bool
	src     *EventSource
	timers  []int64
}

func newHubHarness(t *testing.T, task Task) *hubHarness {
	t.Helper()
	root := t.TempDir()
	now := evT0
	busy := false
	queue := [][]SourceEvent{}
	fired := [][2]string{}
	changed := []string{}
	src := &EventSource{ID: "fake", MinIntervalMs: 1000, Validate: func(json.RawMessage, Task) string { return "" },
		Poll: func(context.Context, json.RawMessage, *string, Task) (PollResult, error) {
			var evs []SourceEvent
			if len(queue) > 0 {
				evs, queue = queue[0], queue[1:]
			}
			c := "c"
			return PollResult{Events: evs, Cursor: &c}, nil
		}}
	h := &hubHarness{queue: &queue, fired: &fired, changed: &changed, root: root, now: &now, busy: &busy, src: src}
	h.hub = NewEventHub(EventHubDeps{
		Root:    root,
		Sources: func() []*EventSource { return []*EventSource{h.src} },
		Fire: func(id, key string) CmdResult {
			if busy {
				return CmdResult{Reason: "busy"}
			}
			fired = append(fired, [2]string{id, key})
			return CmdResult{OK: true}
		},
		Changed: func(id string) { changed = append(changed, id) },
		LastEventKey: func(string) string {
			if len(fired) == 0 {
				return ""
			}
			return fired[len(fired)-1][1]
		},
		Log: &nopLog{},
		Now: func() int64 { return now },
		SetTimer: func(_ func(), ms int64) func() {
			h.timers = append(h.timers, ms)
			return func() {}
		},
	})
	h.hub.Start([]Task{task})
	return h
}

func (h *hubHarness) push(evs ...SourceEvent) { *h.queue = append(*h.queue, evs) }

func batchKeys(evs []SourceEvent) []string {
	out := []string{}
	for _, e := range evs {
		out = append(out, e.Key)
	}
	return out
}

func TestEventHubBaselineDedupeSortBatch(t *testing.T) {
	h := newHubHarness(t, evTask("act", 0))
	h.push(sev("old", evT0))
	h.hub.Tick()
	if len(*h.fired) != 0 {
		t.Fatal(*h.fired)
	}
	*h.now += 2000
	h.push(sev("b", evT0+2), sev("a", evT0+1), sev("old", evT0))
	h.hub.Tick()
	if len(*h.fired) != 1 {
		t.Fatal(*h.fired)
	}
	if got := batchKeys(h.hub.Batch("task_1", (*h.fired)[0][1])); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatal(got)
	}
	*h.now += 2000
	h.push(sev("a", evT0), sev("b", evT0))
	h.hub.Tick()
	if len(*h.fired) != 1 {
		t.Fatal(*h.fired)
	}
}

func TestEventHubObserve(t *testing.T) {
	h := newHubHarness(t, evTask("observe", 0))
	h.hub.Tick()
	*h.now += 2000
	h.push(sev("x", evT0), sev("y", evT0))
	h.hub.Tick()
	if len(*h.fired) != 0 {
		t.Fatal(*h.fired)
	}
	if got := batchKeys(h.hub.Observed("task_1")); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Fatal(got)
	}
	if len(*h.changed) == 0 || (*h.changed)[0] != "task_1" {
		t.Fatal(*h.changed)
	}
	if r := h.hub.ProcessObserved("task_1"); !r.OK {
		t.Fatal(r)
	}
	if n := len(h.hub.Batch("task_1", (*h.fired)[0][1])); n != 2 {
		t.Fatal(n)
	}
	if n := len(h.hub.Observed("task_1")); n != 0 {
		t.Fatal(n)
	}
	if r := h.hub.ProcessObserved("task_1"); r.OK || r.Reason != "empty" {
		t.Fatal(r)
	}
	h.push(sev("z", evT0))
	*h.now += 2000
	h.hub.Tick()
	h.hub.ClearObserved("task_1")
	if n := len(h.hub.Observed("task_1")); n != 0 {
		t.Fatal(n)
	}
}

func TestEventHubCooldownWindowWhileBusy(t *testing.T) {
	task := evTask("act", 60_000)
	h := newHubHarness(t, task)
	h.hub.Tick()
	*h.now += 2000
	h.push(sev("1", evT0))
	h.hub.Tick()
	if len(*h.fired) != 0 {
		t.Fatal(*h.fired)
	}
	*h.now += 60_000
	*h.busy = true
	h.hub.Tick()
	if len(*h.fired) != 0 {
		t.Fatal(*h.fired)
	}
	h.push(sev("2", evT0))
	*h.now += 2000
	h.hub.Tick()
	*h.busy = false
	task.UpdatedAt = 1
	h.hub.Sync(task)
	if len(*h.fired) != 1 {
		t.Fatal(*h.fired)
	}
	if got := batchKeys(h.hub.Batch("task_1", (*h.fired)[0][1])); !reflect.DeepEqual(got, []string{"1", "2"}) {
		t.Fatal(got)
	}
}

// 任务忙碌时过期窗口不再安排 0 延时定时器；空闲后只开一次（#236）
func TestEventHubBusyExpiredWindowNoZeroTimer(t *testing.T) {
	task := evTask("act", 60_000)
	h := newHubHarness(t, task)
	h.hub.Tick()
	*h.now += 2000
	h.push(sev("1", evT0))
	*h.busy = true
	running := task
	running.Status = StatusRunning
	running.UpdatedAt = 1
	h.hub.Sync(running)
	h.hub.Tick()
	*h.now += 120_000
	h.timers = nil
	h.hub.Tick()
	h.hub.Tick()
	if len(h.timers) == 0 {
		t.Fatal("no timer armed")
	}
	for _, ms := range h.timers {
		if ms <= 0 {
			t.Fatalf("zero-delay timer while busy: %v", h.timers)
		}
	}
	*h.busy = false
	task.UpdatedAt = 2
	h.hub.Sync(task)
	if len(*h.fired) != 1 {
		t.Fatal(*h.fired)
	}
}

func TestEventHubFullBatchFiresAtOnce(t *testing.T) {
	h := newHubHarness(t, evTask("act", 600_000))
	h.hub.Tick()
	*h.now += 2000
	evs := []SourceEvent{}
	for i := 0; i < MaxEventBatch+3; i++ {
		evs = append(evs, sev(fmt.Sprintf("k%d", i), evT0+int64(i)))
	}
	h.push(evs...)
	h.hub.Tick()
	if len(*h.fired) != 1 {
		t.Fatal(*h.fired)
	}
	if n := len(h.hub.Batch("task_1", (*h.fired)[0][1])); n != MaxEventBatch {
		t.Fatal(n)
	}
}

func TestEventHubReleaseOnFailureAndPersist(t *testing.T) {
	h := newHubHarness(t, evTask("act", 0))
	h.hub.Tick()
	*h.now += 2000
	h.push(sev("a", evT0))
	h.hub.Tick()
	if len(*h.fired) != 1 {
		t.Fatal(*h.fired)
	}
	failed := evTask("act", 0)
	failed.Status = StatusFailed
	h.hub.Sync(failed)
	idle := evTask("act", 0)
	idle.UpdatedAt = 2
	h.hub.Sync(idle)
	*h.now += 2000
	h.push(sev("a", evT0))
	h.hub.Tick()
	if len(*h.fired) != 2 {
		t.Fatal(*h.fired)
	}
	ents, _ := os.ReadDir(h.root)
	if len(ents) != 1 || ents[0].Name() != "task_1.json" {
		t.Fatal(ents)
	}
	raw, _ := os.ReadFile(filepath.Join(h.root, "task_1.json"))
	var st map[string]any
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatal(err)
	}
	seen, _ := st["seen"].([]any)
	if len(seen) == 0 || seen[len(seen)-1] != "a" {
		t.Fatal(string(raw))
	}
	for _, k := range []string{"cursor", "primed", "observed", "window", "batches", "failures", "lastPollAt", "nextPollAt"} {
		if _, ok := st[k]; !ok {
			t.Fatalf("missing %s: %s", k, raw)
		}
	}
	// 重启后读回状态：同样的事件不再触发
	h.hub.Stop()
	h.hub.states = map[string]*EventState{}
	h.hub.Start([]Task{idle})
	*h.now += 2000
	h.push(sev("a", evT0))
	h.hub.Tick()
	if len(*h.fired) != 2 {
		t.Fatal(*h.fired)
	}
}

func TestEventHubPollFailureBackoff(t *testing.T) {
	h := newHubHarness(t, evTask("act", 0))
	h.src.Poll = func(context.Context, json.RawMessage, *string, Task) (PollResult, error) {
		return PollResult{}, errors.New("boom")
	}
	h.hub.Tick()
	st := h.hub.Status("task_1")
	if st.LastError == nil || *st.LastError != "boom" {
		t.Fatal(st)
	}
	h.hub.mu.Lock()
	next := *h.hub.state("task_1").NextPollAt
	h.hub.mu.Unlock()
	if next != evT0+2000 {
		t.Fatal(next - evT0)
	}
}

// ---------- 事件源 ----------

func newRedirectServer(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/next", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("followed"))
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/"
}

func TestWebSourcePageAndRedirect(t *testing.T) {
	body, status := "<html><script>x()</script><p>v1</p></html>", 200
	src := NewWebSource(WebSourceDeps{T: i18n.Identity, Now: func() int64 { return evT0 },
		Resolve: func(string) error { return nil },
		Fetch: func(_ context.Context, _ string, _ map[string]string, _ int64) (WebResponse, error) {
			hd := http.Header{}
			hd.Set("etag", `"e1"`)
			return WebResponse{Status: status, Headers: hd, Body: body}, nil
		}})
	task := evTask("observe", 0)
	if src.Validate(json.RawMessage(`{"url":"http://127.0.0.1/"}`), task) == "" {
		t.Fatal("private url should fail")
	}
	if v := src.Validate(json.RawMessage(`{"url":"https://example.com/"}`), task); v != "" {
		t.Fatal(v)
	}
	f := json.RawMessage(`{"url":"https://example.com/"}`)
	r1, err := src.Poll(context.Background(), f, nil, task)
	if err != nil || len(r1.Events) != 0 {
		t.Fatal(err, r1)
	}
	body = "<p>v2</p>"
	r2, err := src.Poll(context.Background(), f, r1.Cursor, task)
	if err != nil || len(r2.Events) != 1 || r2.Events[0].Payload.(map[string]any)["excerpt"] != "v2" {
		t.Fatal(err, r2)
	}
	status = 304
	if r3, err := src.Poll(context.Background(), f, r2.Cursor, task); err != nil || len(r3.Events) != 0 || r3.Cursor != r2.Cursor {
		t.Fatal(err, r3)
	}
	status = 302
	if _, err := src.Poll(context.Background(), f, nil, task); err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatal(err)
	}
	if got := PageText("<style>a{}</style><b>hi</b> &amp; you"); got != "hi & you" {
		t.Fatal(got)
	}
}

func TestWebSourceDefaultFetchDoesNotFollowRedirects(t *testing.T) {
	srv := newRedirectServer(t)
	res, err := defaultWebFetch(context.Background(), srv, map[string]string{}, 10)
	if err != nil || res.Status != 302 {
		t.Fatal(err, res.Status)
	}
}

func TestParseFeed(t *testing.T) {
	rss := `<rss><channel><item><title>A</title><link>https://x/a</link><guid>g1</guid>
      <pubDate>Mon, 02 Nov 2026 01:00:00 GMT</pubDate></item></channel></rss>`
	atom := `<feed><entry><id>tag:1</id><title><![CDATA[B &amp; C]]></title>
      <link href="https://x/b"/><updated>2026-11-02T01:00:00Z</updated></entry></feed>`
	if got := ParseFeed(rss); !reflect.DeepEqual(got, []FeedItem{{ID: "g1", Title: "A", Link: "https://x/a", At: evT0}}) {
		t.Fatalf("%+v", got)
	}
	if got := ParseFeed(atom); !reflect.DeepEqual(got, []FeedItem{{ID: "tag:1", Title: "B & C", Link: "https://x/b", At: evT0}}) {
		t.Fatalf("%+v", got)
	}
}

func TestGithubSource(t *testing.T) {
	calls := []GithubReadParams{}
	src := NewGithubSource(GithubSourceDeps{T: i18n.Identity, Now: func() int64 { return evT0 },
		Read: func(_ context.Context, p GithubReadParams, _ []ConnectionGrant) (any, error) {
			calls = append(calls, p)
			if p.Endpoint == "issues" {
				return []any{map[string]any{"number": 7.0, "title": "bug", "updated_at": "2026-11-02T02:00:00Z", "html_url": "u", "state": "open"}}, nil
			}
			return map[string]any{"workflow_runs": []any{
				map[string]any{"id": 1.0, "name": "ci", "status": "completed", "conclusion": "failure", "head_branch": "main", "html_url": "u", "updated_at": "2026-11-02T02:00:00Z"},
				map[string]any{"id": 2.0, "name": "ci", "status": "in_progress", "conclusion": nil, "head_branch": "main", "html_url": "u", "updated_at": "2026-11-02T02:00:00Z"},
			}}, nil
		}})
	task := evTask("observe", 0)
	task.Grant.Connections = []ConnectionGrant{{ConnectionID: "c", Capabilities: []string{"github.read"}, Resources: []string{"o/r"}}}
	if v := src.Validate(json.RawMessage(`{"repo":"x/y","watch":"issues"}`), task); !strings.Contains(v, "not granted") {
		t.Fatal(v)
	}
	if v := src.Validate(json.RawMessage(`{"repo":"o/r","watch":"issues"}`), task); v != "" {
		t.Fatal(v)
	}
	f := json.RawMessage(`{"repo":"o/r","watch":"issues"}`)
	base, err := src.Poll(context.Background(), f, nil, task)
	if err != nil || len(base.Events) != 0 || !base.Baseline || *base.Cursor != "2026-11-02T01:00:00.000Z" {
		t.Fatal(err, base)
	}
	r, err := src.Poll(context.Background(), f, base.Cursor, task)
	if err != nil || !reflect.DeepEqual(batchKeys(r.Events), []string{"github:o/r#7:2026-11-02T02:00:00Z"}) || *r.Cursor != "2026-11-02T02:00:00Z" {
		t.Fatal(err, r)
	}
	if c := calls[0]; c.Endpoint != "issues" || c.Since != *base.Cursor || c.State != "all" {
		t.Fatal(c)
	}
	ci, err := src.Poll(context.Background(), json.RawMessage(`{"repo":"o/r","watch":"ci","branch":"main"}`), nil, task)
	if err != nil || !reflect.DeepEqual(batchKeys(ci.Events), []string{"github:o/r:run:1:failure"}) || calls[1].Branch != "main" {
		t.Fatal(err, ci)
	}
}

func TestFolderSource(t *testing.T) {
	dir := t.TempDir()
	src := NewFolderSource(FolderSourceDeps{T: i18n.Identity, Now: func() int64 { return evT0 }})
	task := evTask("observe", 0)
	task.Grant.Paths = []string{dir}
	// 授权范围外的绝对路径：用临时目录的上级（Windows 上 "/" 不算绝对路径）
	outside, _ := json.Marshal(map[string]string{"path": filepath.Dir(dir)})
	if v := src.Validate(outside, task); !strings.Contains(v, "not granted") {
		t.Fatal(v)
	}
	fj, _ := json.Marshal(map[string]string{"path": dir})
	if v := src.Validate(fj, task); v != "" {
		t.Fatal(v)
	}
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o600)
	r1, err := src.Poll(context.Background(), fj, nil, task)
	if err != nil || len(r1.Events) != 0 || !r1.Baseline {
		t.Fatal(err, r1)
	}
	_ = os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o600)
	_ = os.Mkdir(filepath.Join(dir, "node_modules"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "node_modules", "x.js"), []byte("x"), 0o600)
	r2, err := src.Poll(context.Background(), fj, r1.Cursor, task)
	if err != nil || r2.Baseline || len(r2.Events) != 1 || r2.Events[0].Payload.(map[string]any)["file"] != "b.txt" {
		t.Fatal(err, r2)
	}
}

func TestAppSource(t *testing.T) {
	var cli func(CliFinished)
	var kb func()
	src := NewAppSource(AppBus{
		OnCliFinished:      func(fn func(CliFinished)) func() { cli = fn; return func() { cli = nil } },
		OnKnowledgeChanged: func(fn func()) func() { kb = fn; return func() { kb = nil } },
	}, AppSourceDeps{T: i18n.Identity, Now: func() int64 { return evT0 }})
	got := []SourceEvent{}
	off := src.Subscribe(json.RawMessage(`{"event":"cli.finished","backend":"codex"}`), evTask("observe", 0),
		func(e SourceEvent) { got = append(got, e) })
	cli(CliFinished{TabID: "t1", Title: "x", Backend: "codex", OK: true})
	cli(CliFinished{TabID: "t2", Title: "x", Backend: "codex", OK: true, TaskTab: true})
	cli(CliFinished{TabID: "t3", Title: "x", Backend: "claude", OK: true})
	if len(got) != 1 {
		t.Fatal(got)
	}
	off()
	if cli != nil {
		t.Fatal("not unsubscribed")
	}
	src.Subscribe(json.RawMessage(`{"event":"knowledge.updated"}`), evTask("observe", 0), func(e SourceEvent) { got = append(got, e) })
	kb()
	if len(got) != 2 {
		t.Fatal(got)
	}
	if src.Validate(json.RawMessage(`{"event":"nope"}`), evTask("observe", 0)) == "" {
		t.Fatal("bad event should fail")
	}
}

// 事件任务经 app 源走完整链路：订阅 → act 窗口 → 运行时 FireEvent → 执行者拿到这一批
func TestServiceEventTaskEndToEnd(t *testing.T) {
	now := evT0
	subs := make(chan func(CliFinished), 4)
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, Notify: func(string, string) {},
		Now: func() int64 { return now }, SetTimer: func(func(), int64) func() { return func() {} }})
	s.RegisterSource(NewAppSource(AppBus{OnCliFinished: func(fn func(CliFinished)) func() { subs <- fn; return func() {} }},
		AppSourceDeps{T: i18n.Identity, Now: func() int64 { return now }}))
	got := make(chan []SourceEvent, 1)
	s.RegisterExecutor("nomi", &eventExec{s: s, got: got})
	s.Start()
	defer s.Stop()
	src, mode, cd := "app", "act", int64(0)
	task, err := s.Create(CreateRequest{Title: "t", Goal: "g",
		Trigger:  Trigger{Kind: "event", SourceID: &src, Filter: json.RawMessage(`{"event":"cli.finished"}`), Mode: &mode, CooldownMs: &cd},
		Executor: ExecutorSpec{Kind: "nomi"}, Grant: Grant{Level: 1}}, "user")
	if err != nil {
		t.Fatal(err)
	}
	var cli func(CliFinished)
	select {
	case cli = <-subs:
	case <-time.After(3 * time.Second):
		t.Fatal("not subscribed")
	}
	cli(CliFinished{TabID: "t1", Title: "x", Backend: "codex", OK: true})
	select {
	case evs := <-got:
		if len(evs) != 1 || !strings.HasPrefix(evs[0].Key, "app:cli:t1:") {
			t.Fatal(evs)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("not fired")
	}
	rec := s.Get(task.ID)
	if a := rec.Attempts[len(rec.Attempts)-1]; a.Cause.Kind != "event" || a.Cause.EventKey == nil {
		t.Fatalf("%+v", a.Cause)
	}
}

type eventExec struct {
	s   *Service
	got chan []SourceEvent
}

func (eventExec) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	return ExecutionSnapshot{GrantVersion: t.Grant.Version}, nil
}
func (e *eventExec) Start(ctx AttemptContext) {
	e.got <- e.s.EventBatch(ctx.Task.ID, ctx.Attempt.Cause.EventKey)
}
func (eventExec) Resume(string, int, Answer) {}
func (eventExec) Stop(string, int, string)   {}

func TestServiceEventTriggerValidateAndSetMode(t *testing.T) {
	s := NewService(ServiceDeps{Root: t.TempDir(), Log: &nopLog{}, SetTimer: func(func(), int64) func() { return func() {} }})
	s.RegisterSource(&EventSource{ID: "web", MinIntervalMs: 1000, Validate: func(f json.RawMessage, _ Task) string {
		var v struct {
			URL string `json:"url"`
		}
		_ = json.Unmarshal(f, &v)
		if v.URL == "" {
			return "url required"
		}
		return ""
	}})
	tools := []string{"read"}
	base := CreateRequest{Title: "a", Goal: "g", Executor: ExecutorSpec{Kind: "nomi", Tools: &tools}, Grant: Grant{Level: 1}}
	trig := func(src, filter, mode string) Trigger {
		return Trigger{Kind: "event", SourceID: &src, Filter: json.RawMessage(filter), Mode: &mode}
	}
	in := base
	in.Trigger = trig("nope", `{}`, "observe")
	var te *TriggerError
	if _, err := s.Create(in, "user"); !errors.As(err, &te) || !strings.Contains(err.Error(), "unknown event source") {
		t.Fatal(err)
	}
	in.Trigger = trig("web", `{}`, "observe")
	if _, err := s.Create(in, "user"); err == nil || !strings.Contains(err.Error(), "url required") {
		t.Fatal(err)
	}
	in.Trigger = trig("web", `{"url":"https://x"}`, "observe")
	task, err := s.Create(in, "user")
	if err != nil {
		t.Fatal(err)
	}
	tr := trig("web", `{"url":"https://y"}`, "act")
	u, err := s.Update(task.ID, Patch{Trigger: &tr})
	if err != nil || string(u.Trigger.Filter) != `{"url":"https://y"}` || *u.Trigger.Mode != "observe" {
		t.Fatal(err, u)
	}
	bad := trig("web", `{}`, "observe")
	if _, err := s.Update(task.ID, Patch{Trigger: &bad}); err == nil {
		t.Fatal("want error")
	}
	if m := s.SetMode(task.ID, "act"); m == nil || *m.Trigger.Mode != "act" {
		t.Fatal(m)
	}
}
