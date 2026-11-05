package shellhandlers

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
)

// InstallConversations 挂 conversations.*（对话窗口的会话存储，userData/conversations/）。
// 每次写完推 conversations.changed（带调用方传的 source），别的窗口据此重新取索引。
func InstallConversations(r *contract.Router, s *convstore.Store) {
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
		return s.State(), nil
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
	r.Call("conversations.append", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
	r.Call("conversations.replace", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
	r.Call("conversations.put", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
	r.Call("conversations.delete", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
		emit(in.Source, true, in.ID)
		return nil, nil
	})
	r.Call("conversations.setPointers", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
	r.Call("conversations.import", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
	r.Call("conversations.markMigrated", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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
