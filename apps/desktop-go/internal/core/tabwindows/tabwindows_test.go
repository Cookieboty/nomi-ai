package tabwindows

import (
	"net/url"
	"reflect"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

type fakeOpener struct {
	mu      sync.Mutex
	opened  map[string]func()
	queries map[string]string
	titles  map[string]string
	focused []string
	fail    bool
}

func newFake() *fakeOpener {
	return &fakeOpener{opened: map[string]func(){}, queries: map[string]string{}, titles: map[string]string{}}
}

func (f *fakeOpener) OpenDetached(id, title, query string, onClosed func()) error {
	if f.fail {
		return errFake
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opened[id] = onClosed
	f.queries[id] = query
	f.titles[id] = title
	return nil
}
func (f *fakeOpener) FocusDetached(id string) {
	f.mu.Lock()
	f.focused = append(f.focused, id)
	f.mu.Unlock()
}
func (f *fakeOpener) CloseDetached(id string) {
	f.mu.Lock()
	cb := f.opened[id]
	delete(f.opened, id)
	f.mu.Unlock()
	if cb != nil {
		cb()
		cb() // 外壳可能重复通知：只算一次
	}
}

type fakeErr struct{}

func (fakeErr) Error() string { return "boom" }

var errFake = fakeErr{}

type emitted struct {
	event string
	data  any
}

func setup() (*Manager, *fakeOpener, *[]emitted) {
	f := newFake()
	var events []emitted
	var mu sync.Mutex
	m := New(func() Opener { return f }, func(e string, d any) {
		mu.Lock()
		events = append(events, emitted{e, d})
		mu.Unlock()
	})
	return m, f, &events
}

const spec = `{"v":1,"kind":"agent","scope":"nomi:c1","key":"harness:t1","target":{"kind":"harness","tabId":"t1"}}`

func TestDetachOpensOnceThenFocuses(t *testing.T) {
	m, f, events := setup()
	r, err := m.Detach(DetachInput{ID: "a", Title: "Claude", Spec: spec})
	if err != nil || !r.OK || r.Focused {
		t.Fatalf("first detach: %+v %v", r, err)
	}
	q, _ := url.ParseQuery(f.queries["a"])
	if q.Get(QueryKey) != spec {
		t.Fatalf("query carries the spec verbatim, got %q", f.queries["a"])
	}
	if f.titles["a"] != "Claude" {
		t.Fatalf("title passed through: %q", f.titles["a"])
	}
	r, err = m.Detach(DetachInput{ID: "a", Title: "Claude", Spec: spec})
	if err != nil || !r.OK || !r.Focused || len(f.opened) != 1 || !reflect.DeepEqual(f.focused, []string{"a"}) {
		t.Fatalf("duplicate detach should focus the existing window: %+v %v %v", r, err, f.focused)
	}
	if got := m.List(); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("list: %v", got)
	}
	if len(*events) != 1 || (*events)[0].event != EventChanged {
		t.Fatalf("one change event for the new window: %+v", *events)
	}
}

func TestClosingWindowRemovesIt(t *testing.T) {
	m, f, events := setup()
	_, _ = m.Detach(DetachInput{ID: "a", Spec: spec})
	_, _ = m.Detach(DetachInput{ID: "b", Spec: spec})
	f.CloseDetached("a") // 用户关窗 / 退出时外壳调 onClosed
	if got := m.List(); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("list after close: %v", got)
	}
	last := (*events)[len(*events)-1]
	if last.event != EventChanged || !reflect.DeepEqual(last.data, []string{"b"}) {
		t.Fatalf("change event after close: %+v", last)
	}
	// 关掉后再弹出是新窗口
	if r, _ := m.Detach(DetachInput{ID: "a", Spec: spec}); r.Focused {
		t.Fatal("reopen after close should create a window")
	}
}

func TestDockEmitsThenCloses(t *testing.T) {
	m, f, events := setup()
	if m.Dock("nope") {
		t.Fatal("dock of unknown id")
	}
	_, _ = m.Detach(DetachInput{ID: "a", Spec: spec})
	*events = nil
	if !m.Dock("a") {
		t.Fatal("dock")
	}
	if len(*events) != 2 || (*events)[0].event != EventDocked || (*events)[1].event != EventChanged {
		t.Fatalf("docked first, then list change: %+v", *events)
	}
	if !reflect.DeepEqual((*events)[0].data, map[string]any{"id": "a"}) {
		t.Fatalf("docked payload: %+v", (*events)[0].data)
	}
	if len(f.opened) != 0 || len(m.List()) != 0 {
		t.Fatal("window closed")
	}
}

func TestDetachValidation(t *testing.T) {
	m, f, _ := setup()
	for _, in := range []DetachInput{
		{ID: "", Spec: spec},
		{ID: "a", Spec: "not json"},
		{ID: "a", Spec: "[1]"},
		{ID: string(make([]byte, maxID+1)), Spec: spec},
	} {
		if _, err := m.Detach(in); err == nil {
			t.Fatalf("expected error for %+v", in.Spec)
		}
	}
	f.fail = true
	if _, err := m.Detach(DetachInput{ID: "x", Spec: spec}); err == nil || len(m.List()) != 0 {
		t.Fatal("failed open is not recorded")
	}
	none := New(func() Opener { return nil }, nil)
	if _, err := none.Detach(DetachInput{ID: "x", Spec: spec}); err == nil {
		t.Fatal("no shell → unavailable")
	}
}

func TestWindowLimit(t *testing.T) {
	m, _, _ := setup()
	for i := 0; i < maxWindows; i++ {
		if _, err := m.Detach(DetachInput{ID: string(rune('a' + i)), Spec: spec}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Detach(DetachInput{ID: "overflow", Spec: spec}); err == nil {
		t.Fatal("limit")
	}
}

func TestTitle(t *testing.T) {
	if got := Title("  Claude\n ", "Nomi"); got != "Claude — Nomi" {
		t.Fatal(got)
	}
	if got := Title("", "Nomi"); got != "Nomi" {
		t.Fatal(got)
	}
	if got := Title("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二", "Nomi"); len([]rune(got)) != 80+1+len([]rune(" — Nomi")) {
		t.Fatalf("truncate: %q", got)
	}
}

func TestRegister(t *testing.T) {
	r := contract.NewRouter()
	m, _, _ := setup()
	Register(r, m)
	reg := r.Registered()
	for _, n := range []string{"chatWindow.detachTab", "chatWindow.detachedTabs", "chatWindow.dockTab"} {
		if _, ok := reg[n]; !ok {
			t.Errorf("missing %s", n)
		}
	}
}
