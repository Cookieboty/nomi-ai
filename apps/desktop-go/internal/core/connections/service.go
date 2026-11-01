package connections

// 连接服务，对应 src/connections/ConnectionService.ts：存储 userData/connections.json（不含密钥原文），
// 复用本机 gh 登录或粘贴令牌（经系统加密保存），复核账号与权限，按授权收窄 github.read。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
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
}

type Service struct {
	d     Deps
	mu    sync.Mutex
	items []stored
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
	s := &Service{d: d}
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
