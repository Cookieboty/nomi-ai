package shellhandlers

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
)

// OnConversationDeleted：会话删掉时收起还挂着的提问、中止这一轮（main 里接上）
var OnConversationDeleted func(id string)

// ConversationWrites 记会话写入的进行情况：退出前（宿主的 OnShutdown）用 WaitIdle 等对话窗口排着的
// 写入写完。视图的写队列一次发一个、前一个回来后立刻发下一个，所以「没有进行中的、且安静了 quiet」
// 就说明队列空了。
type ConversationWrites struct {
	mu       sync.Mutex
	inflight int
	last     time.Time
}

func (w *ConversationWrites) begin() {
	w.mu.Lock()
	w.inflight++
	w.last = time.Now()
	w.mu.Unlock()
}

func (w *ConversationWrites) end() {
	w.mu.Lock()
	w.inflight--
	w.last = time.Now()
	w.mu.Unlock()
}

func (w *ConversationWrites) idle(quiet time.Duration) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.inflight == 0 && (w.last.IsZero() || time.Since(w.last) >= quiet)
}

// WaitIdle 等到没有进行中的会话写入、且最近 quiet 内没有新的写入，最多等 max；返回是否等到了。
// 最近没写过的话立刻返回（退出不变慢）。
func (w *ConversationWrites) WaitIdle(max, quiet time.Duration) bool {
	if w == nil {
		return true
	}
	deadline := time.Now().Add(max)
	for !w.idle(quiet) {
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
	return true
}

// InstallConversations 挂 conversations.*（对话窗口的会话存储，userData/conversations/）。
// 每次写完推 conversations.changed（带调用方传的 source），别的窗口据此重新取索引。
// 返回写入的进行情况（退出前等写完）。
func InstallConversations(r *contract.Router, s *convstore.Store) *ConversationWrites {
	w := &ConversationWrites{}
	// 写入类的处理函数：记进行中 / 最近一次写
	write := func(name string, f contract.CallFunc) {
		r.Call(name, func(ctx context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
			w.begin()
			defer w.end()
			return f(ctx, c, raw)
		})
	}
	emit := func(source string, index bool, ids ...string) {
		if ids == nil {
			ids = []string{}
		}
		r.EmitTo("conversations.changed", map[string]any{"source": source, "ids": ids, "index": index}, "chat")
	}
	fail := func(err error) error {
		switch {
		case errors.Is(err, convstore.ErrNotFound):
			return &contract.Error{Code: "CONVERSATION_NOT_FOUND", Message: err.Error()}
		case errors.Is(err, convstore.ErrBadID), errors.Is(err, convstore.ErrBadMessage):
			return &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		return err
	}

	r.Call("conversations.state", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		st, err := s.State()
		if err != nil {
			return nil, fail(err)
		}
		return st, nil
	})
	r.Call("conversations.messages", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID    string `json:"id"`
			Limit int    `json:"limit"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		msgs, err := s.Messages(in.ID, in.Limit)
		if err != nil {
			return nil, fail(err)
		}
		n := 0
		for _, m := range msgs {
			n += len(m) + 1
		}
		return map[string]any{"messages": msgs, "bytes": n}, nil
	})
	write("conversations.append", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Source   string            `json:"source"`
			ID       string            `json:"id"`
			Messages []json.RawMessage `json:"messages"`
			Meta     json.RawMessage   `json:"meta"`
			Preview  *string           `json:"preview"`
			Max      int               `json:"max"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		if err := s.Append(convstore.AppendInput{ID: in.ID, Messages: in.Messages, Meta: in.Meta, Preview: in.Preview, Max: in.Max}); err != nil {
			return nil, fail(err)
		}
		emit(in.Source, len(in.Meta) > 0, in.ID)
		return nil, nil
	})
	write("conversations.replace", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Source   string            `json:"source"`
			ID       string            `json:"id"`
			Messages []json.RawMessage `json:"messages"`
			Meta     json.RawMessage   `json:"meta"`
			Preview  *string           `json:"preview"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		if in.Messages == nil {
			in.Messages = []json.RawMessage{}
		}
		if err := s.Replace(in.ID, in.Messages, in.Meta, in.Preview); err != nil {
			return nil, fail(err)
		}
		emit(in.Source, len(in.Meta) > 0, in.ID)
		return nil, nil
	})
	write("conversations.put", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Source   string            `json:"source"`
			Meta     json.RawMessage   `json:"meta"`
			Messages []json.RawMessage `json:"messages"`
			Preview  *string           `json:"preview"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		id, err := s.Put(in.Meta, in.Messages, in.Preview)
		if err != nil {
			return nil, fail(err)
		}
		emit(in.Source, true, id)
		return nil, nil
	})
	write("conversations.delete", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Source string `json:"source"`
			ID     string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		if err := s.Delete(in.ID); err != nil {
			return nil, fail(err)
		}
		if OnConversationDeleted != nil {
			OnConversationDeleted(in.ID)
		}
		emit(in.Source, true, in.ID)
		return nil, nil
	})
	write("conversations.setPointers", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Source   string          `json:"source"`
			Current  json.RawMessage `json:"current"`
			LastNomi json.RawMessage `json:"lastNomi"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		cur, err := pointer(in.Current)
		if err != nil {
			return nil, badInput(err)
		}
		last, err := pointer(in.LastNomi)
		if err != nil {
			return nil, badInput(err)
		}
		if err := s.SetPointers(cur, last); err != nil {
			return nil, fail(err)
		}
		emit(in.Source, true)
		return nil, nil
	})
	write("conversations.import", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Meta     json.RawMessage   `json:"meta"`
			Messages []json.RawMessage `json:"messages"`
			Preview  *string           `json:"preview"`
			First    bool              `json:"first"`
			Final    bool              `json:"final"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		ok, err := s.Import(convstore.ImportInput{Meta: in.Meta, Messages: in.Messages, Preview: in.Preview, First: in.First, Final: in.Final})
		if err != nil {
			return nil, fail(err)
		}
		return map[string]any{"imported": ok}, nil
	})
	write("conversations.markMigrated", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Count int `json:"count"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		if err := s.MarkMigrated(in.Count); err != nil {
			return nil, err
		}
		emit("", true)
		return nil, nil
	})
	return w
}

// pointer：字段没传 = 不变（nil），null = 清空（""），字符串 = 设成它
func pointer(raw json.RawMessage) (convstore.Pointer, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if string(raw) == "null" {
		empty := ""
		return &empty, nil
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return &v, nil
}
