package knowledgehandlers

// tasks.*：持续任务，对应 src/contract/knowledge.ts 的 tasks 段（docs/design/persistent-tasks.md §14）。

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

type taskIDIn struct {
	ID string `json:"id"`
}

func taskHandlers(sv Services) map[string]H {
	get := func() (*tasks.Service, error) { return need(sv.Tasks, "tasks") }
	type T = tasks.Service
	cmd := func(c tasks.Command) H {
		return on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Command(in.ID, c), nil
		})
	}
	return map[string]H{
		"tasks.list":  on(get, func(_ context.Context, s *T, _ json.RawMessage) (any, error) { return s.List(), nil }),
		"tasks.inbox": on(get, func(_ context.Context, s *T, _ json.RawMessage) (any, error) { return s.Inbox(), nil }),
		"tasks.get": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			if r := s.Get(in.ID); r != nil {
				return r, nil
			}
			return nil, nil
		}),
		"tasks.journal": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Journal(in.ID), nil
		}),
		"tasks.create": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in tasks.CreateRequest
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Create(in, "user"), nil
		}),
		"tasks.update": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID string `json:"id"`
				tasks.Patch
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			t := s.Update(in.ID, in.Patch)
			if t == nil {
				return nil, &contract.Error{Code: "TASKS_NOT_FOUND", Message: in.ID}
			}
			return t, nil
		}),
		"tasks.grant": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID    string      `json:"id"`
				Grant tasks.Grant `json:"grant"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Command(in.ID, tasks.Command{Type: "grant", Grant: &in.Grant}), nil
		}),
		"tasks.revoke": cmd(tasks.Command{Type: "revoke"}),
		"tasks.pause":  cmd(tasks.Command{Type: "pause"}),
		"tasks.resume": cmd(tasks.Command{Type: "resume"}),
		"tasks.cancel": cmd(tasks.Command{Type: "cancel"}),
		"tasks.runNow": cmd(tasks.Command{Type: "runNow"}),
		"tasks.accept": cmd(tasks.Command{Type: "accept"}),
		"tasks.decide": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID string `json:"id"`
				tasks.Command
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			in.Command.Type = "decide"
			return s.Command(in.ID, in.Command), nil
		}),
		"tasks.reject": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID       string `json:"id"`
				Feedback string `json:"feedback"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Command(in.ID, tasks.Command{Type: "reject", Feedback: in.Feedback}), nil
		}),
		"tasks.reconcile": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID      string `json:"id"`
				Outcome string `json:"outcome"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Command(in.ID, tasks.Command{Type: "reconcile", Outcome: in.Outcome}), nil
		}),
		"tasks.applyWorktree": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			apply := sv.ApplyWorktree
			if apply == nil {
				// 没有桌面能力：一个都不写（同 Node：没有 desktop 时 mayWrite 为 false）
				apply = func(_ tasks.CliIsolation, files []string) tasks.WorktreeApply {
					return tasks.WorktreeApply{Applied: []string{}, Skipped: []string{}, Conflicted: []string{}, Denied: append([]string{}, files...)}
				}
			}
			if r := s.ApplyWorktree(in.ID, apply); r != nil {
				return r, nil
			}
			return nil, nil
		}),
		"tasks.remove": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Remove(in.ID), nil
		}),
	}
}
