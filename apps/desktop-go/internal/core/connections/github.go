// Package connections 移植 src/connections：连接（docs/design/connections.md）。2.1.0 先做 GitHub。
package connections

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

type GhAccount struct {
	Host        string   `json:"host"`
	Login       string   `json:"login"`
	Scopes      []string `json:"scopes"`
	TokenSource string   `json:"tokenSource"`
	Active      bool     `json:"active"`
	State       string   `json:"state"`
}

var wide = map[string]bool{"repo": true, "workflow": true, "delete_repo": true, "write:packages": true,
	"delete:packages": true, "write:org": true, "write:public_key": true, "write:repo_hook": true}

// WideScopes：远多于「读」的权限（如实提示）
func WideScopes(scopes []string) []string {
	out := []string{}
	for _, s := range scopes {
		if wide[s] || strings.HasPrefix(s, "admin:") {
			out = append(out, s)
		}
	}
	return out
}

// ParseAuthStatus：`gh auth status --json hosts` 的输出（不含令牌）
func ParseAuthStatus(raw []byte) []GhAccount {
	var v struct {
		Hosts map[string][]struct {
			Login       *string `json:"login"`
			Scopes      any     `json:"scopes"`
			TokenSource string  `json:"tokenSource"`
			Active      bool    `json:"active"`
			State       string  `json:"state"`
		} `json:"hosts"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return []GhAccount{}
	}
	out := []GhAccount{}
	hosts := make([]string, 0, len(v.Hosts))
	for h := range v.Hosts {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	for _, host := range hosts {
		for _, a := range v.Hosts[host] {
			if a.Login == nil {
				continue
			}
			scopes := []string{}
			if s, ok := a.Scopes.(string); ok {
				for _, x := range strings.Split(s, ",") {
					if x = strings.TrimSpace(x); x != "" {
						scopes = append(scopes, x)
					}
				}
			}
			out = append(out, GhAccount{Host: host, Login: *a.Login, Scopes: scopes, TokenSource: a.TokenSource, Active: a.Active, State: a.State})
		}
	}
	return out
}

var GithubEndpoints = []string{"repo", "issues", "issue", "issue_comments", "pulls", "pull", "commits", "check_runs", "workflow_runs", "notifications"}

type ReadParams struct {
	Endpoint     string  `json:"endpoint"`
	Repo         *string `json:"repo,omitempty"`
	Number       *int    `json:"number,omitempty"`
	Ref          *string `json:"ref,omitempty"`
	Since        *string `json:"since,omitempty"`
	State        *string `json:"state,omitempty"`
	Branch       *string `json:"branch,omitempty"`
	ConnectionID *string `json:"connection_id,omitempty"`
}

var (
	repoRE  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
	refRE   = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,200}$`)
	sinceRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$`)
	hostRE  = regexp.MustCompile(`^[A-Za-z0-9.-]{1,200}$`)
)

var ErrBadParams = errors.New("bad_params")

// BuildReadRequest：能力 github.read 的请求模板（全部校验，拒绝拼出模板以外的路径）
func BuildReadRequest(p ReadParams) (path string, query url.Values, err error) {
	bad := func(what string) error { return fmt.Errorf("%w: invalid %s", ErrBadParams, what) }
	repo := func() (string, error) {
		if p.Repo == nil || !repoRE.MatchString(*p.Repo) {
			return "", bad("repo")
		}
		return *p.Repo, nil
	}
	num := func() (int, error) {
		if p.Number == nil || *p.Number <= 0 || *p.Number >= 1e9 {
			return 0, bad("number")
		}
		return *p.Number, nil
	}
	q := url.Values{"per_page": {"50"}}
	if p.Since != nil {
		if !sinceRE.MatchString(*p.Since) {
			return "", nil, bad("since")
		}
		q.Set("since", *p.Since)
	}
	if p.State != nil {
		if *p.State != "open" && *p.State != "closed" && *p.State != "all" {
			return "", nil, bad("state")
		}
		q.Set("state", *p.State)
	}
	switch p.Endpoint {
	case "notifications":
		return "/notifications", q, nil
	}
	r, err := repo()
	if err != nil {
		return "", nil, err
	}
	switch p.Endpoint {
	case "repo":
		return "/repos/" + r, url.Values{}, nil
	case "issues":
		return "/repos/" + r + "/issues", q, nil
	case "issue", "issue_comments", "pull":
		n, err := num()
		if err != nil {
			return "", nil, err
		}
		switch p.Endpoint {
		case "issue":
			return fmt.Sprintf("/repos/%s/issues/%d", r, n), url.Values{}, nil
		case "pull":
			return fmt.Sprintf("/repos/%s/pulls/%d", r, n), url.Values{}, nil
		}
		return fmt.Sprintf("/repos/%s/issues/%d/comments", r, n), q, nil
	case "pulls":
		return "/repos/" + r + "/pulls", q, nil
	case "commits":
		if p.Ref != nil {
			if !refRE.MatchString(*p.Ref) {
				return "", nil, bad("ref")
			}
			q.Set("sha", *p.Ref)
		}
		return "/repos/" + r + "/commits", q, nil
	case "check_runs":
		if p.Ref == nil || !refRE.MatchString(*p.Ref) {
			return "", nil, bad("ref")
		}
		return "/repos/" + r + "/commits/" + url.PathEscape(*p.Ref) + "/check-runs", url.Values{"per_page": {"50"}}, nil
	case "workflow_runs":
		if p.Branch != nil {
			if !refRE.MatchString(*p.Branch) {
				return "", nil, bad("branch")
			}
			q.Set("branch", *p.Branch)
		}
		return "/repos/" + r + "/actions/runs", q, nil
	}
	return "", nil, bad("endpoint")
}

// FilterByRepos：通知不按单个仓库请求，结果里只留授权范围内仓库的条目
func FilterByRepos(endpoint string, data any, repos []string) any {
	list, ok := data.([]any)
	if endpoint != "notifications" || repos == nil || !ok {
		return data
	}
	allow := map[string]bool{}
	for _, r := range repos {
		allow[strings.ToLower(r)] = true
	}
	out := []any{}
	for _, n := range list {
		m, _ := n.(map[string]any)
		repo, _ := m["repository"].(map[string]any)
		if name, _ := repo["full_name"].(string); allow[strings.ToLower(name)] {
			out = append(out, n)
		}
	}
	return out
}

const ghTimeout = 30 * time.Second

// GhEnv：子进程环境只留必要变量、关交互；不传任何 *_TOKEN（gh 里环境变量优先于已存的登录）
func GhEnv(base []string) []string {
	keep := map[string]bool{"PATH": true, "HOME": true, "USERPROFILE": true, "APPDATA": true, "LOCALAPPDATA": true,
		"XDG_CONFIG_HOME": true, "GH_CONFIG_DIR": true, "SystemRoot": true, "TMPDIR": true, "TEMP": true, "TMP": true}
	out := []string{}
	for _, kv := range base {
		if k, _, ok := strings.Cut(kv, "="); ok && keep[k] {
			out = append(out, kv)
		}
	}
	return append(out, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1")
}

// RunGh：返回 stdout 与退出码；没装 gh 时 127
type RunGh func(ctx context.Context, args []string) (stdout []byte, code int)

func DefaultRunGh(ctx context.Context, args []string) ([]byte, int) {
	ctx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Env = GhEnv(os.Environ())
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err == nil {
		return out.Bytes(), 0
	}
	if errors.Is(err, exec.ErrNotFound) {
		return nil, 127
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.Bytes(), ee.ExitCode()
	}
	return out.Bytes(), 1
}

func GhAccounts(ctx context.Context, run RunGh, host string) (installed bool, accounts []GhAccount) {
	args := []string{"auth", "status", "--json", "hosts", "--no-refresh"}
	if host != "" {
		args = append(args, "--hostname", host)
	}
	out, code := run(ctx, args)
	if code == 127 {
		return false, []GhAccount{}
	}
	if code != 0 && len(out) == 0 {
		return true, []GhAccount{}
	}
	return true, ParseAuthStatus(out)
}

func ghGet(ctx context.Context, run RunGh, host, path string, q url.Values) (any, error) {
	full := path
	if enc := q.Encode(); enc != "" {
		full += "?" + enc
	}
	out, code := run(ctx, []string{"api", "--method", "GET", "--hostname", host, full})
	if code != 0 {
		s := string(out)
		if len(s) > 300 {
			s = s[:300]
		}
		return nil, fmt.Errorf("gh api failed (%d): %s", code, s)
	}
	var v any
	if err := json.Unmarshal(out, &v); err != nil {
		return nil, err
	}
	return v, nil
}

func APIBase(host string) string {
	if host == "github.com" {
		return "https://api.github.com"
	}
	return "https://" + host + "/api/v3"
}

// HTTPDo：可注入的请求函数
type HTTPDo func(req *http.Request) (*http.Response, error)

// tokenGet：带令牌的 GET（令牌只在这一刻出现在内核内存里）；scopes nil = 不知道（细粒度令牌）
func tokenGet(ctx context.Context, do HTTPDo, host, token, path string, q url.Values) (any, []string, error) {
	raw := APIBase(host) + path
	if enc := q.Encode(); enc != "" {
		raw += "?" + enc
	}
	if _, err := security.AssertPublicHttpUrl(raw); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "nomi")
	res, err := do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("GitHub %d", res.StatusCode)
	}
	var v any
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		return nil, nil, err
	}
	var scopes []string
	if _, ok := res.Header["X-Oauth-Scopes"]; ok {
		scopes = []string{}
		for _, s := range strings.Split(res.Header.Get("X-Oauth-Scopes"), ",") {
			if s = strings.TrimSpace(s); s != "" {
				scopes = append(scopes, s)
			}
		}
	}
	return v, scopes, nil
}
