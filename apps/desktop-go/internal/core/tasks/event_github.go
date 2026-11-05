package tasks

// `github` 事件源（docs/features/scheduling-calendar.md），对应 src/tasks/events/sources/github.ts：经连接只读轮询——
// issue / PR 的新动态（`since` 游标）、CI（workflow runs，跑完的才算事件）。按任务授权里的连接与仓库收窄
// （GithubRead 的后台授权检查）。

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

type GithubFilter struct {
	Repo string `json:"repo"`
	// Watch：issues = issue / PR 的新建、更新、评论；ci = CI 跑完
	Watch string `json:"watch"`
	// Branch：watch=ci 时的分支
	Branch *string `json:"branch,omitempty"`
}

// GithubReadParams：connections.ReadParams 的子集（tasks 不依赖 connections 包）
type GithubReadParams struct {
	Endpoint string // issues | workflow_runs
	Repo     string
	Since    string
	State    string
	Branch   string
}

// GithubReader：经连接只读（connections.Service.GithubRead，带任务授权）；返回解码后的 JSON
type GithubReader func(ctx context.Context, p GithubReadParams, grant []ConnectionGrant) (any, error)

type GithubSourceDeps struct {
	Read GithubReader
	Now  func() int64
	T    i18n.Translate
}

var (
	ghBranchRE = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,200}$`)
)

func repoGranted(t Task, repo string) bool {
	for _, c := range t.Grant.Connections {
		has := false
		for _, x := range c.Capabilities {
			if x == "github.read" {
				has = true
			}
		}
		if !has {
			continue
		}
		for _, r := range c.Resources {
			if strings.EqualFold(r, repo) {
				return true
			}
		}
	}
	return false
}

// recode：把 GithubRead 的通用 JSON 转成具体结构
func recode(v any, out any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

func parseISO(s string) int64 {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UnixMilli()
	}
	return 0
}

func NewGithubSource(d GithubSourceDeps) *EventSource {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.T
	}
	orNow := func(ms int64) int64 {
		if ms == 0 {
			return d.Now()
		}
		return ms
	}
	return &EventSource{
		ID:            "github",
		MinIntervalMs: 5 * 60_000,
		Validate: func(filter json.RawMessage, t Task) string {
			var f GithubFilter
			if len(filter) == 0 || json.Unmarshal(filter, &f) != nil || !connections.IsRepo(f.Repo) {
				return "repo required"
			}
			if f.Watch != "issues" && f.Watch != "ci" {
				return "bad watch"
			}
			if f.Branch != nil && !ghBranchRE.MatchString(*f.Branch) {
				return "bad branch"
			}
			if !repoGranted(t, f.Repo) {
				return "repo not granted: " + f.Repo
			}
			return ""
		},
		Poll: func(ctx context.Context, filter json.RawMessage, cursor *string, t Task) (PollResult, error) {
			var f GithubFilter
			if err := json.Unmarshal(filter, &f); err != nil {
				return PollResult{}, err
			}
			if d.Read == nil {
				return PollResult{}, fmt.Errorf("connections unavailable")
			}
			grant := t.Grant.Connections
			events := []SourceEvent{}
			if f.Watch == "issues" {
				// 第一次拉：游标定在现在，之前的不算（hub 也会把这次当基线）
				if cursor == nil {
					c := time.UnixMilli(d.Now()).UTC().Format("2006-01-02T15:04:05.000Z")
					return PollResult{Events: events, Cursor: &c, Baseline: true}, nil
				}
				raw, err := d.Read(ctx, GithubReadParams{Endpoint: "issues", Repo: f.Repo, Since: *cursor, State: "all"}, grant)
				if err != nil {
					return PollResult{}, err
				}
				var list []struct {
					Number      int    `json:"number"`
					Title       string `json:"title"`
					UpdatedAt   string `json:"updated_at"`
					HTMLURL     string `json:"html_url"`
					State       string `json:"state"`
					PullRequest any    `json:"pull_request"`
					User        *struct {
						Login string `json:"login"`
					} `json:"user"`
					Comments *int `json:"comments"`
				}
				_ = recode(raw, &list)
				maxC := *cursor
				for _, it := range list {
					if it.UpdatedAt > maxC {
						maxC = it.UpdatedAt
					}
					kind := "issue"
					if it.PullRequest != nil {
						kind = "PR"
					}
					payload := map[string]any{"repo": f.Repo, "kind": kind, "number": it.Number, "title": it.Title,
						"state": it.State, "url": it.HTMLURL, "updatedAt": it.UpdatedAt}
					if it.User != nil && it.User.Login != "" {
						payload["author"] = it.User.Login
					}
					if it.Comments != nil {
						payload["comments"] = *it.Comments
					}
					events = append(events, SourceEvent{
						Key:        fmt.Sprintf("github:%s#%d:%s", f.Repo, it.Number, it.UpdatedAt),
						OccurredAt: orNow(parseISO(it.UpdatedAt)),
						Summary:    d.T("electron.common.task-event-github-item", f.Repo, kind, it.Number, it.Title),
						Payload:    payload,
					})
				}
				return PollResult{Events: events, Cursor: &maxC}, nil
			}
			p := GithubReadParams{Endpoint: "workflow_runs", Repo: f.Repo}
			if f.Branch != nil {
				p.Branch = *f.Branch
			}
			raw, err := d.Read(ctx, p, grant)
			if err != nil {
				return PollResult{}, err
			}
			var r struct {
				WorkflowRuns []struct {
					ID         int64   `json:"id"`
					Name       string  `json:"name"`
					Status     string  `json:"status"`
					Conclusion *string `json:"conclusion"`
					HeadBranch string  `json:"head_branch"`
					HTMLURL    string  `json:"html_url"`
					UpdatedAt  string  `json:"updated_at"`
				} `json:"workflow_runs"`
			}
			_ = recode(raw, &r)
			for _, run := range r.WorkflowRuns {
				if run.Status != "completed" {
					continue
				}
				concl := ""
				if run.Conclusion != nil {
					concl = *run.Conclusion
				}
				events = append(events, SourceEvent{
					Key:        fmt.Sprintf("github:%s:run:%d:%s", f.Repo, run.ID, concl),
					OccurredAt: orNow(parseISO(run.UpdatedAt)),
					Summary:    d.T("electron.common.task-event-github-run", f.Repo, run.Name, run.HeadBranch, concl),
					Payload: map[string]any{"repo": f.Repo, "workflow": run.Name, "branch": run.HeadBranch,
						"conclusion": run.Conclusion, "url": run.HTMLURL},
				})
			}
			c := "primed"
			if cursor != nil {
				c = *cursor
			}
			return PollResult{Events: events, Cursor: &c}, nil
		},
	}
}
