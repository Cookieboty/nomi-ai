package knowledgehandlers

// tasks.*：持续任务（docs/features/scheduling-calendar.md）。

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

type taskIDIn struct {
	ID string `json:"id"`
}

// taskEventsView：契约 TaskEventsView
type taskEventsView struct {
	Observed   []tasks.SourceEvent `json:"observed"`
	LastPollAt *int64              `json:"lastPollAt,omitempty"`
	LastError  *string             `json:"lastError,omitempty"`
	Sources    []string            `json:"sources"`
}

// tasksErr：TriggerError → TASKS_BAD_TRIGGER、GrantError → TASKS_BAD_GRANT（mapped('TASKS', …)）
func tasksErr(v any, err error) (any, error) { return mapped("TASKS", v, err) }

func taskHandlers(sv Services) map[string]H {
	get := func() (*tasks.Service, error) { return need(sv.Tasks, "tasks") }
	type T = tasks.Service
	cmd := func(c tasks.Command) H {
		return on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.Command(in.ID, c))
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
		"tasks.trace": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.TraceView(in.ID), nil
		}),
		"tasks.create": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in tasks.CreateRequest
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return tasksErr(s.Create(in, "user"))
		}),
		"tasks.update": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID string `json:"id"`
				tasks.Patch
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			t, err := s.Update(in.ID, in.Patch)
			if err != nil {
				return tasksErr(nil, err)
			}
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
			return tasksErr(s.Command(in.ID, tasks.Command{Type: "grant", Grant: &in.Grant}))
		}),
		"tasks.revoke": cmd(tasks.Command{Type: "revoke"}),
		"tasks.pause":  cmd(tasks.Command{Type: "pause"}),
		"tasks.resume": cmd(tasks.Command{Type: "resume"}),
		"tasks.cancel":          cmd(tasks.Command{Type: "cancel"}),
		"tasks.runNow":          cmd(tasks.Command{Type: "runNow"}),
		"tasks.accept":          cmd(tasks.Command{Type: "accept"}),
		"tasks.archive":         cmd(tasks.Command{Type: "archive", Outcome: "user"}),
		"tasks.unarchive":       cmd(tasks.Command{Type: "unarchive"}),
		"tasks.ack":             cmd(tasks.Command{Type: "ack"}),
		"tasks.archiveAllEnded": on(get, func(_ context.Context, s *T, _ json.RawMessage) (any, error) {
			return map[string]int{"archived": s.ArchiveAllEnded()}, nil
		}),
		"tasks.decide": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID string `json:"id"`
				tasks.Command
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			in.Command.Type = "decide"
			return plain(s.Command(in.ID, in.Command))
		}),
		"tasks.reject": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID       string `json:"id"`
				Feedback string `json:"feedback"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.Command(in.ID, tasks.Command{Type: "reject", Feedback: in.Feedback}))
		}),
		"tasks.steer": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Steer(in.ID, in.Text), nil
		}),
		"tasks.followUp": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID         string                `json:"id"`
				Text       string                `json:"text"`
				UpdateGoal bool                  `json:"updateGoal"`
				Images     []tasks.FollowUpImage `json:"images"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.FollowUpWithOptions(in.ID, in.Text, in.UpdateGoal, in.Images...), nil
		}),
		"tasks.appendQueued": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID     string                `json:"id"`
				Text   string                `json:"text"`
				Images []tasks.FollowUpImage `json:"images"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.AppendQueued(in.ID, in.Text, in.Images...), nil
		}),
		"tasks.handoffFromChat": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ReqID           string `json:"reqId"`
				ConversationID  string `json:"conversationId"`
				ProjectID       string `json:"projectId"`
				Title           string `json:"title"`
				UserGoal        string `json:"userGoal"`
				PartialContent  string `json:"partialContent"`
				ProgressSummary string `json:"progressSummary"`
				HistoryContext  string `json:"historyContext"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			if in.ReqID != "" && sv.AbortChatReq != nil {
				sv.AbortChatReq(in.ReqID)
			}
			var cwd string
			var paths []string
			if sv.ResolveWorkspace != nil && in.ProjectID != "" {
				cwd, paths = sv.ResolveWorkspace(in.ProjectID)
			}
			task, err := s.CreateHandoff(tasks.HandoffInput{
				ConversationID:  in.ConversationID,
				ProjectID:       in.ProjectID,
				Title:           in.Title,
				UserGoal:        in.UserGoal,
				PartialContent:  in.PartialContent,
				ProgressSummary: in.ProgressSummary,
				HistoryContext:  in.HistoryContext,
				Cwd:             cwd,
				Paths:           paths,
			})
			if err != nil {
				return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
			}
			return task, nil
		}),
		"tasks.reconcile": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID      string `json:"id"`
				Outcome string `json:"outcome"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return plain(s.Command(in.ID, tasks.Command{Type: "reconcile", Outcome: in.Outcome}))
		}),
		"tasks.applyWorktree": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			apply := sv.ApplyWorktree
			if apply == nil {
				// 没有桌面能力：一个都不写（mayWrite 为 false）
				apply = func(_ tasks.CliIsolation, files []string, _ string) tasks.WorktreeApply {
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
		// 事件任务：观察到的事件、最近一次拉取
		"tasks.events": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			st := s.Events.Status(in.ID)
			return taskEventsView{Observed: s.Events.Observed(in.ID), LastPollAt: st.LastPollAt, LastError: st.LastError,
				Sources: s.Events.SourceIDs()}, nil
		}),
		"tasks.processObserved": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			return s.Events.ProcessObserved(in.ID), nil
		}),
		"tasks.clearObserved": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in taskIDIn
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			s.Events.ClearObserved(in.ID)
			return true, nil
		}),
		// 只记录 ↔ 自动执行；改成自动执行是放宽授权（契约里 dangerous）
		"tasks.setMode": on(get, func(_ context.Context, s *T, raw json.RawMessage) (any, error) {
			var in struct {
				ID   string `json:"id"`
				Mode string `json:"mode"`
			}
			if err := decode(raw, &in); err != nil {
				return nil, err
			}
			if t := s.SetMode(in.ID, in.Mode); t != nil {
				return t, nil
			}
			return nil, nil
		}),
	}
}
