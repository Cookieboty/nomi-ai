// Package connections：连接（docs/features/scheduling-calendar.md）。2.1.0 先做 GitHub。
package connections

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
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
		if p.Repo == nil || !IsRepo(*p.Repo) {
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
	hideWindow(cmd)
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

// ---------- 对外能力（C3）：github.comment / github.pr.create ----------

// GithubWriteParams：comment 用 Repo / Number / Body；pr 用 Repo / Head / Base / Title / Body / Draft
type GithubWriteParams struct {
	Repo   string
	Number int
	Body   *string
	// Head：只允许推到 nomi/ 前缀的分支（docs/features/scheduling-calendar.md）
	Head, Base, Title string
	Draft             *bool
	ConnectionID      string
}

// WriteRequest：写请求：方法、路径与字段（字段逐项传，不拼 URL）；Fields 保序，值是 string 或 bool
type WriteRequest struct {
	Method string
	Path   string
	Fields *u.Obj
}

var prHeadRE = regexp.MustCompile(`^nomi/[A-Za-z0-9_./-]{1,200}$`)

const maxWriteBody = 60_000

func badParam(what string) error { return fmt.Errorf("%w: %s", ErrBadParams, what) }

// jsTrim：String.prototype.trim 去掉的空白（含 U+FEFF）
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == 0xFEFF })
}

func BuildCommentRequest(p GithubWriteParams) (WriteRequest, error) {
	if !IsRepo(p.Repo) {
		return WriteRequest{}, badParam("invalid repo")
	}
	if p.Number <= 0 || p.Number >= 1e9 {
		return WriteRequest{}, badParam("invalid number")
	}
	body := ""
	if p.Body != nil {
		body = *p.Body
	}
	if jsTrim(body) == "" || len16(body) > maxWriteBody {
		return WriteRequest{}, badParam("invalid body")
	}
	return WriteRequest{Method: "POST", Path: fmt.Sprintf("/repos/%s/issues/%d/comments", p.Repo, p.Number),
		Fields: u.NewObj("body", body)}, nil
}

func BuildPrRequest(p GithubWriteParams) (WriteRequest, error) {
	if !IsRepo(p.Repo) {
		return WriteRequest{}, badParam("invalid repo")
	}
	if !prHeadRE.MatchString(p.Head) || strings.Contains(p.Head, "..") {
		return WriteRequest{}, badParam("head must be a nomi/ branch")
	}
	if !refRE.MatchString(p.Base) || strings.Contains(p.Base, "..") {
		return WriteRequest{}, badParam("invalid base")
	}
	if jsTrim(p.Title) == "" || len16(p.Title) > 256 {
		return WriteRequest{}, badParam("invalid title")
	}
	body := ""
	if p.Body != nil {
		body = *p.Body
	}
	if len16(body) > maxWriteBody {
		return WriteRequest{}, badParam("invalid body")
	}
	f := u.NewObj("title", p.Title, "head", p.Head, "base", p.Base, "body", body)
	if p.Draft != nil && *p.Draft {
		f.Set("draft", true)
	}
	return WriteRequest{Method: "POST", Path: "/repos/" + p.Repo + "/pulls", Fields: f}, nil
}

// GithubWriteError：GitHub 明确拒绝（4xx 带错误正文）= 确定没生效（Definite）；断网、超时、5xx = 不确定
type GithubWriteError struct {
	Msg      string
	Definite bool
}

func (e *GithubWriteError) Error() string { return e.Msg }

// GhWriteArgs：gh api 的写请求：字符串字段用 --raw-field（不解析 @文件），布尔用 -F
func GhWriteArgs(host string, req WriteRequest) []string {
	// --include：状态行与响应头也写到 stdout，按状态码判断「确定没生效」（4xx）还是不确定（5xx、断网）
	args := []string{"api", "--method", req.Method, "--include", "--hostname", host, req.Path}
	if req.Fields == nil {
		return args
	}
	for _, k := range req.Fields.Keys() {
		switch v := req.Fields.Get(k).(type) {
		case bool:
			args = append(args, "-F", fmt.Sprintf("%s=%t", k, v))
		case string:
			args = append(args, "--raw-field", k+"="+v)
		default:
			args = append(args, "--raw-field", k+"="+u.Str(v))
		}
	}
	return args
}

// IsRepo：owner/name；不接受 `.` / `..` 这样的段（会拼出模板以外的路径）
func IsRepo(r string) bool {
	if !repoRE.MatchString(r) {
		return false
	}
	for _, x := range strings.Split(r, "/") {
		if x == "." || x == ".." {
			return false
		}
	}
	return true
}

var includedStatusRE = regexp.MustCompile(`^HTTP/[\d.]+ (\d{3})`)
var blankLineRE = regexp.MustCompile(`\r?\n\r?\n`)

// SplitIncluded：`gh api --include` 的输出 → 状态码（0 = 没有状态行，请求没拿到响应）与正文
func SplitIncluded(out string) (int, string) {
	m := includedStatusRE.FindStringSubmatch(out)
	if m == nil {
		return 0, out
	}
	status, _ := strconv.Atoi(m[1])
	loc := blankLineRE.FindStringIndex(out)
	if loc == nil {
		return status, ""
	}
	return status, out[loc[1]:]
}

// DefiniteRejection：4xx（除 408 / 429）= GitHub 处理了请求并拒绝，确定没生效
func DefiniteRejection(status int) bool {
	return status >= 400 && status < 500 && status != 408 && status != 429
}

func ghWrite(ctx context.Context, run RunGh, host string, req WriteRequest) (any, error) {
	out, code := run(ctx, GhWriteArgs(host, req))
	status, body := SplitIncluded(string(out))
	var data any
	if b := strings.TrimSpace(body); b != "" {
		data, _ = u.ParseString(b)
	}
	if code == 0 && (status == 0 || status < 300) {
		return data, nil
	}
	msg := fmt.Sprintf("gh %d", code)
	if status != 0 {
		msg = strconv.Itoa(status)
	}
	text := "GitHub " + msg
	if o, ok := data.(*u.Obj); ok {
		if m, ok := o.Get("message").(string); ok {
			text += ": " + m
		}
	}
	return nil, &GithubWriteError{Msg: text, Definite: status != 0 && DefiniteRejection(status)}
}

// tokenWrite：带令牌的写请求
func tokenWrite(ctx context.Context, do HTTPDo, host, token string, req WriteRequest) (any, error) {
	raw := APIBase(host) + req.Path
	if _, err := security.AssertPublicHttpUrl(raw); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	body := "{}"
	if req.Fields != nil {
		body = u.Stringify(req.Fields)
	}
	r, err := http.NewRequestWithContext(ctx, req.Method, raw, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Accept", "application/vnd.github+json")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	r.Header.Set("User-Agent", "nomi")
	res, err := do(r)
	if err != nil {
		return nil, &GithubWriteError{Msg: err.Error()}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		s := res.StatusCode
		return nil, &GithubWriteError{Msg: fmt.Sprintf("GitHub %d", s), Definite: DefiniteRejection(s)}
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		// 已经 2xx：动作生效了，只是读不到结果
		return nil, nil
	}
	v, err := u.Parse(b)
	if err != nil {
		return nil, nil
	}
	return v, nil
}

// len16：JS 字符串长度（UTF-16 码元）
func len16(s string) int { return len(utf16.Encode([]rune(s))) }
