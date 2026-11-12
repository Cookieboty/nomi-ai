package igtools

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/askuser"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestAskUserToolBlocksUntilAnswer(t *testing.T) {
	b := askuser.New(askuser.Options{Timeout: time.Second})
	prev := SetAskBroker(b)
	defer SetAskBroker(prev)

	in := u.NewObj("questions", []any{
		u.NewObj("question", "用哪种？", "options", []any{
			u.NewObj("label", "保留建表"),
			u.NewObj("label", "连建表也不要"),
		}),
	})
	type out struct {
		v   any
		err error
	}
	ch := make(chan out, 1)
	go func() {
		v, err := AskUserTool().Execute(context.Background(), in, tools.ExecContext{ConversationID: "c1"})
		ch <- out{v, err}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for len(b.Pending()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("tool did not register a question")
		}
		time.Sleep(5 * time.Millisecond)
	}
	id := b.Pending()[0].ID
	if !b.Answer(id, askuser.Result{Action: askuser.ActionAnswer, Answers: []askuser.Answer{{QuestionID: "q1", Selected: []string{"b"}}}}) {
		t.Fatal("answer")
	}
	got := <-ch
	if got.err != nil {
		t.Fatal(got.err)
	}
	text, _ := got.v.(string)
	if !strings.Contains(text, "连建表也不要") {
		t.Fatalf("result = %q", text)
	}
}

func TestAskUserToolStopCancels(t *testing.T) {
	b := askuser.New(askuser.Options{Timeout: time.Second})
	prev := SetAskBroker(b)
	defer SetAskBroker(prev)
	ctx, cancel := context.WithCancel(context.Background())
	in := u.NewObj("questions", []any{u.NewObj("question", "继续吗？")})
	errc := make(chan error, 1)
	go func() {
		_, err := AskUserTool().Execute(ctx, in, tools.ExecContext{ConversationID: "c1"})
		errc <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for len(b.Pending()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("not pending")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("stop should cancel the tool")
	}
}

func TestAskUserToolRejectsEmpty(t *testing.T) {
	b := askuser.New(askuser.Options{})
	prev := SetAskBroker(b)
	defer SetAskBroker(prev)
	_, err := AskUserTool().Execute(context.Background(), u.NewObj(), tools.ExecContext{ConversationID: "c1"})
	if err == nil {
		t.Fatal("empty input should fail")
	}
	v, err := AskUserTool().Execute(context.Background(), u.NewObj("questions", []any{u.NewObj("question", "x")}), tools.ExecContext{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(v.(string), "假设") {
		t.Fatalf("no conversation = %v", v)
	}
}
