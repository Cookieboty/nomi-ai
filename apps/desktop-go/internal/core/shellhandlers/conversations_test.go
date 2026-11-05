package shellhandlers_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
)

type convSession struct {
	t  *testing.T
	s  *contract.Session
	ch chan contract.ServerFrame
	n  int
}

func (c *convSession) call(name, input string) contract.ServerFrame {
	c.t.Helper()
	c.n++
	id := string(rune('a' + c.n))
	c.s.Handle([]byte(`{"t":"req","id":"` + id + `","kind":"call","name":"` + name + `","input":` + input + `}`))
	for {
		select {
		case f := <-c.ch:
			if f.T == "event" {
				continue
			}
			if f.ID != id {
				continue
			}
			return f
		case <-time.After(2 * time.Second):
			c.t.Fatal("timeout " + name)
		}
	}
}

func TestConversationsHandlers(t *testing.T) {
	r := contract.NewRouter()
	shellhandlers.InstallConversations(r, convstore.New(t.TempDir()))
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	s.Handle([]byte(`{"t":"sub","event":"conversations.changed"}`))
	c := &convSession{t: t, s: s, ch: ch}

	if f := c.call("conversations.put", `{"source":"w1","meta":{"id":"c1","name":"A"}}`); f.T != "res" {
		t.Fatalf("put: %+v", f)
	}
	if f := c.call("conversations.append", `{"source":"w1","id":"c1","messages":[{"id":"m1","content":"hi"}],"preview":"hi"}`); f.T != "res" {
		t.Fatalf("append: %+v", f)
	}
	if f := c.call("conversations.append", `{"id":"gone","messages":[{"id":"m"}]}`); f.T != "err" || f.Error == nil || f.Error.Code != "CONVERSATION_NOT_FOUND" {
		t.Fatalf("append unknown: %+v", f)
	}
	if f := c.call("conversations.messages", `{"id":"../x"}`); f.T != "err" || f.Error.Code != "BAD_INPUT" {
		t.Fatalf("bad id: %+v", f)
	}
	f := c.call("conversations.messages", `{"id":"c1"}`)
	b, _ := json.Marshal(f.Output)
	if string(b) != `{"bytes":27,"messages":[{"id":"m1","content":"hi"}]}` {
		t.Fatalf("messages: %s", b)
	}
	// 指针：字符串 = 设，null = 清空，不传 = 不变
	c.call("conversations.setPointers", `{"current":"c1","lastNomi":"c1"}`)
	c.call("conversations.setPointers", `{"current":null}`)
	f = c.call("conversations.state", `null`)
	b, _ = json.Marshal(f.Output)
	var st struct {
		Current  string         `json:"current"`
		LastNomi string         `json:"lastNomi"`
		Counts   map[string]int `json:"counts"`
		Previews map[string]string
	}
	_ = json.Unmarshal(b, &st)
	if st.Current != "" || st.LastNomi != "c1" || st.Counts["c1"] != 1 || st.Previews["c1"] != "hi" {
		t.Fatalf("state: %s", b)
	}
}

func TestConversationsChangedEventCarriesSource(t *testing.T) {
	r := contract.NewRouter()
	shellhandlers.InstallConversations(r, convstore.New(t.TempDir()))
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	s.Handle([]byte(`{"t":"sub","event":"conversations.changed"}`))
	s.Handle([]byte(`{"t":"req","id":"1","kind":"call","name":"conversations.put","input":{"source":"w1","meta":{"id":"c1"}}}`))
	deadline := time.After(2 * time.Second)
	for {
		select {
		case f := <-ch:
			if f.T != "event" {
				continue
			}
			b, _ := json.Marshal(f.Data)
			if string(b) != `{"ids":["c1"],"index":true,"source":"w1"}` {
				t.Fatalf("event: %s", b)
			}
			return
		case <-deadline:
			t.Fatal("no event")
		}
	}
}
