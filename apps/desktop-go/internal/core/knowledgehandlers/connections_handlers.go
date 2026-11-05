package knowledgehandlers

// connections.*：应用与账号（docs/features/scheduling-calendar.md）。

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
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
		"connections.rebind": on(get, func(ctx context.Context, s *C, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			before := ""
			if old := s.Get(in.ID); old != nil && old.Account != nil {
				before = old.Account.Login
			}
			c, err := s.Rebind(ctx, in.ID)
			if err != nil {
				return connErr(nil, err)
			}
			// 真的换了账号：引用这条连接的任务都要重新授权（账号没变就不动授权）
			changed := c == nil || c.Account == nil || c.Account.Login != before
			if changed && sv.Tasks != nil {
				if t := sv.Tasks(); t != nil {
					for _, task := range t.List().Tasks {
						for _, g := range task.Grant.Connections {
							if g.ConnectionID == in.ID {
								_, _ = t.Command(task.ID, tasks.Command{Type: "revoke"})
								break
							}
						}
					}
				}
			}
			return c, nil
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
