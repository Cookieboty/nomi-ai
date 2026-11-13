package askuser

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// eventLog records Emit callbacks. Ask runs on another goroutine and can still
// be inside Emit when the test answers or cancels, which emits again.
type eventLog struct {
	mu  sync.Mutex
	got []Event
}

func (l *eventLog) add(ev Event) {
	l.mu.Lock()
	l.got = append(l.got, ev)
	l.mu.Unlock()
}

func (l *eventLog) snapshot() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Event, len(l.got))
	copy(out, l.got)
	return out
}

func testBroker(t *testing.T, timeout time.Duration) (*Broker, *eventLog) {
	t.Helper()
	log := &eventLog{}
	b := New(Options{
		Now:     func() int64 { return 1_000 },
		Timeout: timeout,
		Emit:    log.add,
	})
	return b, log
}

func oneQ() []Question {
	return []Question{{
		ID: "q1", Prompt: "用哪种？", Multi: false,
		Options: []Option{{ID: "a", Label: "保留建表"}, {ID: "b", Label: "连建表也不要"}},
	}}
}

func TestAskAnswerAndSkip(t *testing.T) {
	b, events := testBroker(t, time.Second)
	done := make(chan Result, 1)
	go func() {
		res, err := b.Ask(context.Background(), "conv-1", oneQ())
		if err != nil {
			t.Errorf("ask: %v", err)
		}
		done <- res
	}()
	waitUntil(t, func() bool { return len(b.Pending()) == 1 })
	if !b.WaitingConversations()["conv-1"] {
		t.Fatal("conversation should be waiting")
	}
	pending := b.Pending()
	if pending[0].Source != SourceNomi || pending[0].Questions[0].Prompt != "用哪种？" {
		t.Fatalf("pending = %+v", pending[0])
	}
	if !b.Answer(pending[0].ID, Result{Action: ActionAnswer, Answers: []Answer{{QuestionID: "q1", Selected: []string{"a"}}}, Details: "先别迁数据"}) {
		t.Fatal("answer")
	}
	res := <-done
	if res.Action != ActionAnswer || res.Details != "先别迁数据" {
		t.Fatalf("result = %+v", res)
	}
	text := Format(oneQ(), res)
	if !strings.Contains(text, "保留建表") || !strings.Contains(text, "先别迁数据") {
		t.Fatalf("format = %s", text)
	}
	if len(b.Pending()) != 0 {
		t.Fatal("still pending")
	}
	closed := false
	for _, ev := range events.snapshot() {
		if ev.Closed && ev.ID == pending[0].ID {
			closed = true
		}
	}
	if !closed {
		t.Fatal("missing closed event")
	}

	go func() {
		res, err := b.Ask(context.Background(), "conv-1", oneQ())
		if err != nil {
			t.Errorf("skip: %v", err)
		}
		done <- res
	}()
	waitUntil(t, func() bool { return len(b.Pending()) == 1 })
	id := b.Pending()[0].ID
	if !b.Answer(id, Result{Action: ActionSkip}) {
		t.Fatal("skip")
	}
	if got := <-done; got.Action != ActionSkip || !strings.Contains(Format(oneQ(), got), "跳过") {
		t.Fatalf("skip result = %+v", got)
	}
	if b.Answer(id, Result{Action: ActionAnswer}) {
		t.Fatal("second answer should fail")
	}
}

func TestAskCancelAndTimeout(t *testing.T) {
	b, _ := testBroker(t, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := b.Ask(ctx, "conv-2", oneQ())
		errc <- err
	}()
	waitUntil(t, func() bool { return len(b.Pending()) == 1 })
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("cancel should surface ctx.Err")
	}
	if len(b.Pending()) != 0 {
		t.Fatal("cancel left the card up")
	}

	b2, _ := testBroker(t, 20*time.Millisecond)
	res, err := b2.Ask(context.Background(), "conv-3", oneQ())
	if err != nil || res.Action != ActionTimeout {
		t.Fatalf("timeout = %+v %v", res, err)
	}
	if !strings.Contains(Format(oneQ(), res), "时限") {
		t.Fatal(Format(oneQ(), res))
	}
}

func TestCancelConversationAndTab(t *testing.T) {
	b, _ := testBroker(t, time.Second)
	replied := make(chan Result, 1)
	if !b.Offer("req-1", SourceClaude, "", "tab-9", oneQ(), func(res Result) { replied <- res }) {
		t.Fatal("offer")
	}
	if !b.WaitingTabs()["tab-9"] {
		t.Fatal("tab should be waiting")
	}
	go func() {
		_, _ = b.Ask(context.Background(), "conv-4", oneQ())
	}()
	waitUntil(t, func() bool { return len(b.Pending()) == 2 })
	b.CancelConversation("conv-4")
	waitUntil(t, func() bool { return len(b.Pending()) == 1 })
	b.CancelTab("tab-9", true)
	res := <-replied
	if res.Action != ActionCancel {
		t.Fatalf("tab cancel = %+v", res)
	}
	if len(b.Pending()) != 0 || len(b.Items()) != 0 {
		t.Fatal("cards left")
	}
}

func TestOfferTimeout(t *testing.T) {
	b, _ := testBroker(t, 20*time.Millisecond)
	replied := make(chan Result, 1)
	if !b.Offer("req-2", SourceClaude, "", "tab-1", oneQ(), func(res Result) { replied <- res }) {
		t.Fatal("offer")
	}
	if b.Offer("req-2", SourceClaude, "", "tab-1", oneQ(), func(Result) {}) {
		t.Fatal("duplicate id")
	}
	select {
	case res := <-replied:
		if res.Action != ActionTimeout {
			t.Fatalf("got %+v", res)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout did not reply")
	}
}

func TestQuestionsFromClaudeAndUpdatedInput(t *testing.T) {
	raw := util.NewObj("questions", []any{
		util.NewObj("question", "用哪种？", "header", "迁移", "multiSelect", false, "options", []any{
			util.NewObj("label", "保留建表", "description", "只不回填"),
			util.NewObj("label", "连建表也不要"),
		}),
		util.NewObj("question", "还要哪些？", "multiSelect", true, "options", []any{
			util.NewObj("label", "索引"),
			util.NewObj("label", "注释"),
		}),
	})
	qs, ok := QuestionsFromClaude(raw)
	if !ok || len(qs) != 2 || qs[0].Options[0].ID != "a" || !qs[1].Multi || qs[0].Header != "迁移" {
		t.Fatalf("parsed = %+v ok=%v", qs, ok)
	}
	if _, ok := QuestionsFromClaude(util.NewObj("command", "ls")); ok {
		t.Fatal("a shell command is not a question")
	}
	updated := ClaudeUpdatedInput(raw, qs, Result{
		Action: ActionAnswer,
		Answers: []Answer{
			{QuestionID: "q1", Custom: "我不确定"},
			{QuestionID: "q2", Selected: []string{"a"}, Custom: "外键"},
		},
		Details: "先看旧表",
	})
	answers, _ := updated.Get("answers").(*util.Obj)
	if util.Str(answers.Get("用哪种？")) != "我不确定\n补充：先看旧表" {
		t.Fatalf("single = %v", answers.Get("用哪种？"))
	}
	if util.Str(answers.Get("还要哪些？")) != "索引, 外键" {
		t.Fatalf("multi = %v", answers.Get("还要哪些？"))
	}
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting")
}
