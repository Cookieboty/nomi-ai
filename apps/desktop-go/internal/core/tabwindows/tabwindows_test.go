package tabwindows

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

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
	for _, n := range []string{"chatWindow.detachTab", "chatWindow.detachedTabs", "chatWindow.registerHost", "chatWindow.dockTab", "chatWindow.dockAck", "chatWindow.handoffPut", "chatWindow.handoffTake"} {
		if _, ok := reg[n]; !ok {
			t.Errorf("missing %s", n)
		}
	}
}

// 交接快照：取一次就删；同一个 id 覆盖；坏数据 / 超长拒绝；超过份数丢最早的
func TestHandoff(t *testing.T) {
	m := New(func() Opener { return nil }, nil)
	if err := m.Put("a", `{"v":1}`); err != nil {
		t.Fatal(err)
	}
	if err := m.Put("a", `{"v":2}`); err != nil {
		t.Fatal(err)
	}
	if got, ok := m.Take("a"); !ok || got != `{"v":2}` {
		t.Fatalf("take = %q %v", got, ok)
	}
	if _, ok := m.Take("a"); ok {
		t.Fatal("second take should be empty")
	}
	if m.Put("", `{}`) == nil || m.Put("b", "nope") == nil {
		t.Fatal("bad input accepted")
	}
	if m.Put("b", `"`+strings.Repeat("x", maxHandoff)+`"`) == nil {
		t.Fatal("oversize accepted")
	}
	for i := 0; i < maxHandoffCount+3; i++ {
		if err := m.Put(fmt.Sprintf("k%d", i), `{}`); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := m.Take("k0"); ok {
		t.Fatal("oldest should be dropped")
	}
	if _, ok := m.Take(fmt.Sprintf("k%d", maxHandoffCount+2)); !ok {
		t.Fatal("newest kept")
	}
}

func TestRegisterHostAndDirectionIsolation(t *testing.T) {
	m := New(func() Opener { return nil }, nil)
	done1 := make(chan struct{})
	host1 := contract.Caller{Surface: "chat", ID: 10, Done: done1}
	peer := contract.Caller{Surface: "chat", ID: 20}

	if m.RegisterHost(contract.Caller{Surface: "chat", ID: 0}) {
		t.Fatal("zero callerID should not register host")
	}
	if !m.RegisterHost(host1) {
		t.Fatal("expected host1 registration")
	}

	if err := m.PutWithOptions(host1, HandoffPutInput{ID: "tab1", Data: `{"dir":"detach"}`, Direction: "detach"}); err != nil {
		t.Fatal(err)
	}
	if err := m.PutWithOptions(peer, HandoffPutInput{ID: "tab1", Data: `{"dir":"dock"}`, Direction: "dock"}); err != nil {
		t.Fatal(err)
	}

	// 同 id 方向隔离，且非 host 不能窃取或删除 dock 快照
	if got, ok := m.TakeWithOptions(peer, HandoffTakeInput{ID: "tab1", Direction: "dock"}); ok || got != "" {
		t.Fatalf("peer unexpectedly stole dock snapshot: %q", got)
	}
	if got, ok := m.TakeWithOptions(peer, HandoffTakeInput{ID: "tab1"}); ok || got != "" {
		t.Fatalf("peer unexpectedly stole dock snapshot via untyped take: %q", got)
	}
	if got, ok := m.TakeWithOptions(peer, HandoffTakeInput{ID: "tab1", Direction: "detach"}); !ok || got != `{"dir":"detach"}` {
		t.Fatalf("detach take = %q %v", got, ok)
	}
	if got, ok := m.TakeWithOptions(host1, HandoffTakeInput{ID: "tab1", Direction: "dock"}); !ok || got != `{"dir":"dock"}` {
		t.Fatalf("host dock take = %q %v", got, ok)
	}

	// host 断开后自动清理 hostCallerID
	close(done1)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		hid := m.hostCallerID
		m.mu.Unlock()
		if hid == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("hostCallerID was not cleared after caller.Done closed")
}

func TestTwoPhaseDockSuccessAndConcurrent(t *testing.T) {
	m, _, events := setup()
	hostDone := make(chan struct{})
	defer close(hostDone)
	host := contract.Caller{Surface: "chat", ID: 100, Done: hostDone}
	win1 := contract.Caller{Surface: "chat", ID: 201}
	win2 := contract.Caller{Surface: "chat", ID: 202}
	if !m.RegisterHost(host) {
		t.Fatal("registerHost")
	}

	reqCh := make(chan map[string]string, 4)
	m.SetCallerEmitter(func(callerID int, event string, data any) bool {
		if callerID != host.ID || event != EventDockRequest {
			return false
		}
		raw, _ := json.Marshal(data)
		var p map[string]string
		_ = json.Unmarshal(raw, &p)
		reqCh <- p
		return true
	})

	if _, err := m.Detach(DetachInput{ID: "w1", Title: "W1", Spec: spec}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Detach(DetachInput{ID: "w2", Title: "W2", Spec: spec}); err != nil {
		t.Fatal(err)
	}
	if err := m.PutWithOptions(win1, HandoffPutInput{
		ID: "w1", Data: `{"chat":"w1"}`, TransferID: "tr-1", Direction: "dock", KeepUntilAck: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.PutWithOptions(win2, HandoffPutInput{
		ID: "w2", Data: `{"chat":"w2"}`, TransferID: "tr-2", Direction: "dock", KeepUntilAck: true,
	}); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	res := make([]bool, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		res[0] = m.DockWithOptions(context.Background(), win1, DockInput{ID: "w1", TransferID: "tr-1", RequireAck: true})
	}()
	go func() {
		defer wg.Done()
		res[1] = m.DockWithOptions(context.Background(), win2, DockInput{ID: "w2", TransferID: "tr-2", RequireAck: true})
	}()

	for i := 0; i < 2; i++ {
		req := <-reqCh
		id, tr := req["id"], req["transferId"]
		// 非 host 偷取与非 host ACK 都被拒
		if got, ok := m.TakeWithOptions(win2, HandoffTakeInput{ID: id, Direction: "dock", TransferID: tr}); ok || got != "" {
			t.Fatalf("peer stole pending dock %s", id)
		}
		if m.DockAck(win2, DockAckInput{ID: id, TransferID: tr, OK: true}) {
			t.Fatalf("peer ack must fail for %s", id)
		}
		// keepUntilAck=true：主窗口读取后仍保留，直到 dockAck(ok=true)
		got1, ok1 := m.TakeWithOptions(host, HandoffTakeInput{ID: id, Direction: "dock", TransferID: tr})
		got2, ok2 := m.TakeWithOptions(host, HandoffTakeInput{ID: id, Direction: "dock", TransferID: tr})
		if !ok1 || !ok2 || got1 != got2 {
			t.Fatalf("keepUntilAck failed for %s: %v %v %q", id, ok1, ok2, got1)
		}
		if !m.DockAck(host, DockAckInput{ID: id, TransferID: tr, OK: true}) {
			t.Fatalf("host dockAck failed for %s", id)
		}
	}
	wg.Wait()

	if !res[0] || !res[1] {
		t.Fatalf("concurrent docks failed: %+v", res)
	}
	if len(m.List()) != 0 {
		t.Fatalf("all windows should close after ack, got %v", m.List())
	}
	if _, ok := m.TakeWithOptions(host, HandoffTakeInput{ID: "w1", Direction: "dock"}); ok {
		t.Fatal("w1 dock snapshot should be cleaned after ok ACK")
	}
	dockedCount := 0
	for _, ev := range *events {
		if ev.event == EventDocked {
			dockedCount++
		}
	}
	if dockedCount != 2 {
		t.Fatalf("expected 2 EventDocked, got %d", dockedCount)
	}
}

func TestTwoPhaseDockFailuresPreserveWindowAndSnapshot(t *testing.T) {
	m, _, _ := setup()
	m.SetAckTimeout(30 * time.Millisecond)
	win := contract.Caller{Surface: "chat", ID: 301}
	if _, err := m.Detach(DetachInput{ID: "w1", Title: "W1", Spec: spec}); err != nil {
		t.Fatal(err)
	}

	// 无 host 在线时拒绝关闭窗口
	if m.DockWithOptions(context.Background(), win, DockInput{ID: "w1", TransferID: "t0", RequireAck: true}) {
		t.Fatal("expected dock fail without registered host")
	}
	if len(m.List()) != 1 {
		t.Fatal("window must remain open when no host")
	}

	host := contract.Caller{Surface: "chat", ID: 100}
	m.RegisterHost(host)
	// emitCaller 返回 false（host 未订阅）
	m.SetCallerEmitter(func(int, string, any) bool { return false })
	if err := m.PutWithOptions(win, HandoffPutInput{ID: "w1", Data: `{"k":1}`, TransferID: "t1", Direction: "dock", KeepUntilAck: true}); err != nil {
		t.Fatal(err)
	}
	if m.DockWithOptions(context.Background(), win, DockInput{ID: "w1", TransferID: "t1", RequireAck: true}) {
		t.Fatal("expected fail when emitCaller false")
	}
	if len(m.List()) != 1 {
		t.Fatal("window closed on failed emit")
	}
	if got, ok := m.TakeWithOptions(host, HandoffTakeInput{ID: "w1", Direction: "dock"}); !ok || got != `{"k":1}` {
		t.Fatalf("snapshot lost after failed emit: %q %v", got, ok)
	}

	// host 显式拒绝 (dockAck ok=false) 时保持窗口打开且保留快照
	m.SetCallerEmitter(func(int, string, any) bool {
		go m.DockAck(host, DockAckInput{ID: "w1", TransferID: "t2", OK: false})
		return true
	})
	if err := m.PutWithOptions(win, HandoffPutInput{ID: "w1", Data: `{"k":2}`, TransferID: "t2", Direction: "dock", KeepUntilAck: true}); err != nil {
		t.Fatal(err)
	}
	if m.DockWithOptions(context.Background(), win, DockInput{ID: "w1", TransferID: "t2", RequireAck: true}) {
		t.Fatal("expected fail when host nacks")
	}
	if len(m.List()) != 1 {
		t.Fatal("window must stay open on ok=false ack")
	}
	if got, ok := m.TakeWithOptions(host, HandoffTakeInput{ID: "w1", Direction: "dock"}); !ok || got != `{"k":2}` {
		t.Fatalf("snapshot lost after nack: %q %v", got, ok)
	}

	// ACK 超时保持窗口打开
	m.SetCallerEmitter(func(int, string, any) bool { return true })
	if err := m.PutWithOptions(win, HandoffPutInput{ID: "w1", Data: `{"k":3}`, TransferID: "t3", Direction: "dock", KeepUntilAck: true}); err != nil {
		t.Fatal(err)
	}
	if m.DockWithOptions(context.Background(), win, DockInput{ID: "w1", TransferID: "t3", RequireAck: true}) {
		t.Fatal("expected timeout failure")
	}
	if len(m.List()) != 1 {
		t.Fatal("window must stay open on ack timeout")
	}
}
