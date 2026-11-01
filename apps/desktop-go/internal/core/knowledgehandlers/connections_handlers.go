package knowledgehandlers

// connections.*：外部连接，对应 src/contract/knowledge.ts 的 connections 段（docs/design/connections.md §7）。

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
)

// connErr：connections.Error(code) → CONNECTIONS_<CODE>
func connErr(v any, err error) (any, error) {
	if err == nil {
		return v, nil
	}
	if e, ok := err.(*connections.Error); ok {
		code := "CONNECTIONS_" + strings.ToUpper(e.Code)
		if Declared[code] {
			return nil, &contract.Error{Code: code, Message: e.Msg}
		}
	}
	return nil, err
}

func connectionHandlers(sv Services) map[string]H {
	get := func() (*connections.Service, error) { return need(sv.Conns, "connections") }
	type C = connections.Service
	return map[string]H{
		"connections.list": on(get, func(_ context.Context, s *C, _ json.RawMessage) (any, error) { return s.List(), nil }),
		"connections.detect": on(get, func(ctx context.Context, s *C, raw json.RawMessage) (any, error) {
			var in struct {
				Host string `json:"host"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return connErr(s.Detect(ctx, in.Host))
		}),
		"connections.addGithub": on(get, func(ctx context.Context, s *C, raw json.RawMessage) (any, error) {
			var in connections.AddInput
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return connErr(s.AddGithub(ctx, in))
		}),
		"connections.check": on(get, func(ctx context.Context, s *C, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return connErr(s.Check(ctx, in.ID))
		}),
		"connections.remove": on(get, func(_ context.Context, s *C, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Remove(in.ID), nil
		}),
	}
}
