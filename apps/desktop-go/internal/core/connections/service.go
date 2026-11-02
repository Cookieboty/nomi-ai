package connections

// 连接服务，对应 src/connections/ConnectionService.ts：存储 userData/connections.json（不含密钥原文），
// 复用本机 gh 登录或粘贴令牌（经系统加密保存），复核账号与权限，按授权收窄 github.read。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type Auth struct {
	Kind string `json:"kind"` // cli-login | keychain
	Cli  string `json:"cli,omitempty"`
	Host string `json:"host"`
}

type Account struct {
	Login string `json:"login"`
	Host  string `json:"host"`
}

type Connection struct {
	ID             string   `json:"id"`
	Provider       string   `json:"provider"`
	Label          string   `json:"label"`
	Auth           Auth     `json:"auth"`
	Account        *Account `json:"account,omitempty"`
	ObservedScopes []string `json:"observedScopes,omitempty"`
	WideScopes     []string `json:"wideScopes,omitempty"`
	Status         string   `json:"status"`
	CheckedAt      *int64   `json:"checkedAt,omitempty"`
	CreatedAt      int64    `json:"createdAt"`
	SchemaVersion  int      `json:"schemaVersion"`
}

type stored struct {
	Connection
	Secret string `json:"secret,omitempty"`
}

// Grant：授权里引用连接的方式（同任务授权的 ConnectionGrant）
type Grant struct {
	ConnectionID string   `json:"connectionId"`
	Capabilities []string `json:"capabilities"`
	Resources    []string `json:"resources"`
}

// Error：code = not_found | not_allowed | needs_login | bad_params | unavailable | failed
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

type Deps struct {
	File    string
	Secrets security.SecretBox
	Emit    func(event string, payload any)
	RunGh   RunGh
	HTTP    HTTPDo
	Now     func() int64
	// T：给用户看的摘要（收件箱、核对卡片）跟界面语言走；缺省 i18n.T
	T i18n.Translate
}

// writeGap：两次写请求至少间隔（connections.md §4.2）
const writeGap = time.Second

type Service struct {
	d     Deps
	mu    sync.Mutex
	items []stored
	// writeMu：写请求串行；lastWriteAt 上一次写结束的时刻
	writeMu     sync.Mutex
	lastWriteAt int64
	gap         time.Duration
}

func New(d Deps) *Service {
	if d.RunGh == nil {
		d.RunGh = DefaultRunGh
	}
	if d.HTTP == nil {
		d.HTTP = http.DefaultClient.Do
	}
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.T
	}
	s := &Service{d: d, gap: writeGap}
	if b, err := os.ReadFile(d.File); err == nil {
		var v struct {
			Connections []stored `json:"connections"`
		}
		if json.Unmarshal(b, &v) == nil {
			for _, c := range v.Connections {
				if c.ID != "" && c.Provider == "github" {
					s.items = append(s.items, c)
				}
			}
		}
	}
	return s
}

func (s *Service) saveLocked() {
	items := s.items
	if items == nil {
		items = []stored{}
	}
	b, _ := json.MarshalIndent(map[string]any{"connections": items}, "", "  ")
	_ = utils.WritePrivateFileAtomic(s.d.File, append(b, '\n'))
	if s.d.Emit != nil {
		s.d.Emit("connections.changed", nil)
	}
}

func (s *Service) List() []Connection {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Connection, 0, len(s.items))
	for _, c := range s.items {
		out = append(out, c.Connection)
	}
	return out
}

func (s *Service) Get(id string) *Connection {
	for _, c := range s.List() {
		if c.ID == id {
			return &c
		}
	}
	return nil
}

type DetectAccount struct {
	GhAccount
	WideScopes []string `json:"wideScopes"`
}

type DetectResult struct {
	Gh struct {
		Installed bool            `json:"installed"`
		Accounts  []DetectAccount `json:"accounts"`
	} `json:"gh"`
}

func (s *Service) Detect(ctx context.Context, host string) (DetectResult, error) {
	var r DetectResult
	if host == "" {
		host = "github.com"
	}
	if !hostRE.MatchString(host) {
		return r, &Error{"bad_params", "invalid host"}
	}
	installed, accounts := GhAccounts(ctx, s.d.RunGh, host)
	r.Gh.Installed = installed
	r.Gh.Accounts = []DetectAccount{}
	for _, a := range accounts {
		r.Gh.Accounts = append(r.Gh.Accounts, DetectAccount{GhAccount: a, WideScopes: WideScopes(a.Scopes)})
	}
	return r, nil
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "conn_" + hex.EncodeToString(b)
}

func activeAccount(accounts []GhAccount, host string) *GhAccount {
	for _, a := range accounts {
		if a.Host == host && a.Active && a.State == "success" {
			return &a
		}
	}
	return nil
}

// AddInput：mode = gh | token
type AddInput struct {
	Mode  string `json:"mode"`
	Host  string `json:"host,omitempty"`
	Token string `json:"token,omitempty"`
}

func (s *Service) AddGithub(ctx context.Context, in AddInput) (*Connection, error) {
	host := in.Host
	if host == "" {
		host = "github.com"
	}
	if !hostRE.MatchString(host) {
		return nil, &Error{"bad_params", "invalid host"}
	}
	now := s.d.Now()
	c := stored{Connection: Connection{ID: newID(), Provider: "github", Status: "ok", CheckedAt: &now, CreatedAt: now, SchemaVersion: 1}}
	switch in.Mode {
	case "gh":
		installed, accounts := GhAccounts(ctx, s.d.RunGh, host)
		if !installed {
			return nil, &Error{"unavailable", "gh is not installed"}
		}
		a := activeAccount(accounts, host)
		if a == nil {
			return nil, &Error{"needs_login", "gh is not logged in to " + host}
		}
		c.Label = "GitHub · " + a.Login
		c.Auth = Auth{Kind: "cli-login", Cli: "gh", Host: host}
		c.Account = &Account{Login: a.Login, Host: host}
		c.ObservedScopes = a.Scopes
		c.WideScopes = WideScopes(a.Scopes)
	case "token":
		token := strings.TrimSpace(in.Token)
		if token == "" {
			return nil, &Error{"bad_params", "empty token"}
		}
		data, scopes, err := tokenGet(ctx, s.d.HTTP, host, token, "/user", nil)
		if err != nil {
			return nil, &Error{"needs_login", "token rejected: " + err.Error()}
		}
		m, _ := data.(map[string]any)
		login, _ := m["login"].(string)
		if login == "" {
			return nil, &Error{"failed", "unexpected /user response"}
		}
		enc, err := s.d.Secrets.Encrypt(token, "secure storage is unavailable")
		if err != nil {
			return nil, &Error{"unavailable", err.Error()}
		}
		c.Label = "GitHub · " + login
		c.Auth = Auth{Kind: "keychain", Host: host}
		c.Account = &Account{Login: login, Host: host}
		if scopes != nil {
			c.ObservedScopes = scopes
			c.WideScopes = WideScopes(scopes)
		}
		c.Secret = enc
	default:
		return nil, &Error{"bad_params", "invalid mode"}
	}
	s.mu.Lock()
	s.items = append(s.items, c)
	s.saveLocked()
	s.mu.Unlock()
	return s.Get(c.ID), nil
}

// Check：复核账号与权限；换了账号 / 登出了 → needs_login（不悄悄换账号）
func (s *Service) Check(ctx context.Context, id string) (*Connection, error) {
	s.mu.Lock()
	var c *stored
	for i := range s.items {
		if s.items[i].ID == id {
			c = &s.items[i]
		}
	}
	if c == nil {
		s.mu.Unlock()
		return nil, &Error{"not_found", id}
	}
	snap := *c
	s.mu.Unlock()
	login := ""
	var scopes []string
	if snap.Auth.Kind == "cli-login" {
		_, accounts := GhAccounts(ctx, s.d.RunGh, snap.Auth.Host)
		if a := activeAccount(accounts, snap.Auth.Host); a != nil {
			login, scopes = a.Login, a.Scopes
		}
	} else if data, sc, err := tokenGet(ctx, s.d.HTTP, snap.Auth.Host, s.d.Secrets.Decrypt(snap.Secret), "/user", nil); err == nil {
		m, _ := data.(map[string]any)
		login, _ = m["login"].(string)
		scopes = sc
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.items {
		if s.items[i].ID != id {
			continue
		}
		it := &s.items[i]
		if login != "" && it.Account != nil && login == it.Account.Login {
			it.Status = "ok"
		} else {
			it.Status = "needs_login"
		}
		if scopes != nil {
			it.ObservedScopes = scopes
			it.WideScopes = WideScopes(scopes)
		}
		now := s.d.Now()
		it.CheckedAt = &now
		s.saveLocked()
		c := it.Connection
		return &c, nil
	}
	return nil, &Error{"not_found", id}
}

func (s *Service) Remove(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := s.items[:0:0]
	for _, c := range s.items {
		if c.ID != id {
			keep = append(keep, c)
		}
	}
	if len(keep) == len(s.items) {
		return false
	}
	s.items = keep
	s.saveLocked()
	return true
}

// GithubRead：只发模板内的 GET。grant nil = 前台对话（只读）；有 grant 时连接、能力、仓库都必须在授权里
func (s *Service) GithubRead(ctx context.Context, p ReadParams, grant []Grant) (any, error) {
	s.mu.Lock()
	var c *stored
	for i := range s.items {
		it := s.items[i]
		if p.ConnectionID != nil {
			if it.ID == *p.ConnectionID {
				c = &it
				break
			}
			continue
		}
		if it.Provider != "github" || it.Status != "ok" {
			continue
		}
		if grant != nil {
			found := false
			for _, g := range grant {
				if g.ConnectionID == it.ID {
					found = true
				}
			}
			if !found {
				continue
			}
		}
		c = &it
		break
	}
	s.mu.Unlock()
	if c == nil {
		return nil, &Error{"not_found", "no GitHub connection"}
	}
	if c.Status != "ok" {
		return nil, &Error{"needs_login", c.Label + " needs login"}
	}
	var repos []string
	if grant != nil {
		var g *Grant
		for i := range grant {
			if grant[i].ConnectionID == c.ID && contains(grant[i].Capabilities, "github.read") {
				g = &grant[i]
			}
		}
		if g == nil {
			return nil, &Error{"not_allowed", "github.read is not granted for this task"}
		}
		repos = append([]string{}, g.Resources...)
		if p.Endpoint != "notifications" {
			ok := false
			for _, r := range repos {
				if p.Repo != nil && strings.EqualFold(r, *p.Repo) {
					ok = true
				}
			}
			if !ok {
				repo := ""
				if p.Repo != nil {
					repo = *p.Repo
				}
				return nil, &Error{"not_allowed", "repo " + repo + " is not granted"}
			}
		}
	}
	path, q, err := BuildReadRequest(p)
	if err != nil {
		if errors.Is(err, ErrBadParams) {
			return nil, &Error{"bad_params", err.Error()}
		}
		return nil, err
	}
	var data any
	if c.Auth.Kind == "cli-login" {
		data, err = ghGet(ctx, s.d.RunGh, c.Auth.Host, path, q)
	} else {
		data, _, err = tokenGet(ctx, s.d.HTTP, c.Auth.Host, s.d.Secrets.Decrypt(c.Secret), path, q)
	}
	if err != nil {
		return nil, err
	}
	return FilterByRepos(p.Endpoint, data, repos), nil
}

// FirstOK：第一个可用的连接（task_propose 的 github_repos 用）
func (s *Service) FirstOK() *Connection {
	for _, c := range s.List() {
		if c.Status == "ok" {
			return &c
		}
	}
	return nil
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// ---------- 对外写（github.comment / github.pr.create） ----------

// pickGithub：找能用的 GitHub 连接；有授权时（后台任务）连接、能力、仓库都必须在授权里
func (s *Service) pickGithub(capability, repo, connectionID string, grant []Grant) (*stored, error) {
	usable := func(x stored) bool {
		if x.Provider != "github" || x.Status != "ok" {
			return false
		}
		if grant == nil {
			return true
		}
		for _, g := range grant {
			if g.ConnectionID != x.ID || !contains(g.Capabilities, capability) {
				continue
			}
			for _, r := range g.Resources {
				if strings.EqualFold(r, repo) {
					return true
				}
			}
		}
		return false
	}
	s.mu.Lock()
	var c *stored
	if connectionID != "" {
		for i := range s.items {
			if s.items[i].ID == connectionID {
				x := s.items[i]
				c = &x
				break
			}
		}
	} else {
		for i := range s.items {
			if usable(s.items[i]) {
				x := s.items[i]
				c = &x
				break
			}
		}
		if c == nil {
			for i := range s.items {
				if s.items[i].Provider == "github" {
					x := s.items[i]
					c = &x
					break
				}
			}
		}
	}
	s.mu.Unlock()
	if c == nil {
		return nil, &Error{"not_found", "no GitHub connection"}
	}
	if c.Status != "ok" {
		return nil, &Error{"needs_login", c.Label + " needs login"}
	}
	if grant != nil && !usable(*c) {
		return nil, &Error{"not_allowed", capability + " on " + repo + " is not granted for this task"}
	}
	return c, nil
}

// send：写请求串行，两次至少间隔 writeGap
func (s *Service) send(ctx context.Context, c *stored, req WriteRequest) (any, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if wait := time.Duration(s.lastWriteAt+s.gap.Milliseconds()-s.d.Now()) * time.Millisecond; wait > 0 {
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			// 还没发出去：确定没生效
			return nil, &GithubWriteError{Msg: ctx.Err().Error(), Definite: true}
		}
	}
	defer func() { s.lastWriteAt = s.d.Now() }()
	if c.Auth.Kind == "cli-login" {
		return ghWrite(ctx, s.d.RunGh, c.Auth.Host, req)
	}
	return tokenWrite(ctx, s.d.HTTP, c.Auth.Host, s.d.Secrets.Decrypt(c.Secret), req)
}

// writeResult：GitHub 返回里给模型看的字段（id / number / url）
func writeResult(data any) *u.Obj {
	out := u.NewObj()
	o, _ := data.(*u.Obj)
	if o == nil {
		return out
	}
	if v, ok := o.Get("id").(float64); ok {
		out.Set("id", v)
	}
	if v, ok := o.Get("number").(float64); ok {
		out.Set("number", v)
	}
	if v, ok := o.Get("html_url").(string); ok {
		out.Set("url", v)
	}
	return out
}

// GithubWrite：对外写（github.comment / github.pr.create）。后台任务（grant 非 nil）必须带副作用日志：
// 先写 intent，正文末尾带幂等标记（重启后按它核对），成功写 done；GitHub 明确拒绝写 failed。
// 前台对话（grant 为 nil）由调用方先让用户确认。返回 {id?, number?, url?}
func (s *Service) GithubWrite(ctx context.Context, capability string, p GithubWriteParams, grant []Grant, journal ExternalJournal) (*u.Obj, error) {
	var req WriteRequest
	var err error
	if capability == "github.comment" {
		req, err = BuildCommentRequest(p)
	} else if capability == "github.pr.create" {
		req, err = BuildPrRequest(p)
	} else {
		return nil, &Error{"bad_params", "unknown capability: " + capability}
	}
	if err != nil {
		return nil, &Error{"bad_params", strings.TrimPrefix(err.Error(), "bad_params: ")}
	}
	c, err := s.pickGithub(capability, p.Repo, p.ConnectionID, grant)
	if err != nil {
		return nil, err
	}
	if grant != nil && journal == nil {
		return nil, &Error{"not_allowed", "no side-effect journal"}
	}
	exec := func(marker string) (*u.Obj, error) {
		r := req
		if marker != "" {
			f := req.Fields.Clone()
			f.Set("body", jsTrim(u.Str(f.Get("body"))+"\n\n"+marker))
			r.Fields = f
		}
		data, err := s.send(ctx, c, r)
		if err != nil {
			var we *GithubWriteError
			if errors.As(err, &we) && we.Definite {
				return nil, &ExternalNotAppliedError{Msg: we.Msg}
			}
			return nil, err
		}
		return writeResult(data), nil
	}
	if journal == nil {
		return exec("")
	}
	T := s.d.T
	var summary string
	target := u.NewObj("connectionId", c.ID, "repo", p.Repo)
	if capability == "github.pr.create" {
		summary = T("electron.common.github-pr-summary", p.Repo, p.Head, p.Base) + ": " + p.Title
		target.Set("head", p.Head)
	} else {
		summary = T("electron.common.github-comment-summary", p.Repo, p.Number)
		target.Set("number", p.Number)
	}
	v, err := journal.Run(ExternalAction{Action: capability, Summary: summary, Target: target, Payload: req.Fields},
		func(key string) (any, string, error) {
			r, err := exec(MarkerOf(key))
			if err != nil {
				return nil, "", err
			}
			ext := ""
			if id, ok := r.Get("id").(float64); ok {
				ext = u.FormatNumber(id)
			}
			return r, ext, nil
		})
	if err != nil {
		return nil, err
	}
	r, _ := v.(*u.Obj)
	return r, nil
}

// ReconcileOutcome：自动核对的结论（tasks.ReconcileResult）
type ReconcileOutcome struct {
	Applied    bool
	ExternalID string
}

// GithubReconcile：重启核对（persistent-tasks §10.3）：按 intent 里的幂等标记查评论 / PR 有没有发出去。
// 查到 → Applied；查完确定没有 → !Applied；连接不可用、查询失败 → nil（交给用户）。
// target 来自事件日志：仓库、分支再按写入时的规则校验一遍，不合法按查不了处理。
func (s *Service) GithubReconcile(ctx context.Context, action string, at int64, key string, target *u.Obj) *ReconcileOutcome {
	if key == "" || target == nil {
		return nil
	}
	connID, _ := target.Get("connectionId").(string)
	repo, _ := target.Get("repo").(string)
	if repo == "" || !IsRepo(repo) {
		return nil
	}
	s.mu.Lock()
	var c *stored
	for i := range s.items {
		if s.items[i].ID == connID {
			x := s.items[i]
			c = &x
		}
	}
	s.mu.Unlock()
	if c == nil || c.Status != "ok" {
		return nil
	}
	var path string
	q := url.Values{}
	switch action {
	case "github.comment":
		n, ok := jsNumber(target.Get("number"))
		if !ok || n <= 0 || n >= 1e9 || n != float64(int64(n)) {
			return nil
		}
		path = fmt.Sprintf("/repos/%s/issues/%d/comments", repo, int64(n))
		q.Set("since", time.UnixMilli(at-60_000).UTC().Format("2006-01-02T15:04:05.000Z"))
		q.Set("per_page", "100")
	case "github.pr.create":
		head, ok := target.Get("head").(string)
		if !ok || !prHeadRE.MatchString(head) {
			return nil
		}
		path = "/repos/" + repo + "/pulls"
		q.Set("head", strings.SplitN(repo, "/", 2)[0]+":"+head)
		q.Set("state", "all")
		q.Set("per_page", "100")
	default:
		return nil
	}
	var data any
	var err error
	if c.Auth.Kind == "cli-login" {
		data, err = ghGet(ctx, s.d.RunGh, c.Auth.Host, path, q)
	} else {
		data, _, err = tokenGet(ctx, s.d.HTTP, c.Auth.Host, s.d.Secrets.Decrypt(c.Secret), path, q)
	}
	if err != nil {
		return nil
	}
	list, ok := data.([]any)
	if !ok {
		return nil
	}
	marker := MarkerOf(key)
	for _, x := range list {
		m, _ := x.(map[string]any)
		if body, ok := m["body"].(string); ok && strings.Contains(body, marker) {
			out := &ReconcileOutcome{Applied: true}
			if id, ok := m["id"].(float64); ok {
				out.ExternalID = u.FormatNumber(id)
			}
			return out
		}
	}
	return &ReconcileOutcome{Applied: false}
}

// jsNumber：日志里读回的是 float64；内存里构造的可能是 int
func jsNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}
