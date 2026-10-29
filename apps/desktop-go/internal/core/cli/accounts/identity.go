package accounts

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const statusTimeoutMs = 15_000

// RunStatusResult = { stdout, code }.
type RunStatusResult struct {
	Stdout string
	Code   *int
}

// IdentityDeps = IdentityDeps（所有函数持 jsrt 锁调用；nil 字段 = 未注入）。
type IdentityDeps struct {
	Run           func(kind string, args []string, env *util.Obj) *RunStatusResult
	GrokAuth      func(env *util.Obj) (string, bool)
	CodexAccount  func(env *util.Obj, args []string, withAccountID bool) (*CodexAccountInfo, error)
	WithAccountID bool
	Env           *util.Obj
	Home          string
}

func runStatus(kind string, args []string, env *util.Obj) *RunStatusResult {
	bin := func() (b string) {
		defer func() {
			if recover() != nil {
				b = ""
			}
		}()
		return cli.ResolveCliBinAsync(kind)
	}()
	if bin == "" {
		return nil
	}
	cwd, err := usage.NodeMkdtemp(filepath.Join(os.TempDir(), "nomi-acct-status-"))
	if err != nil {
		panic(jsThrow("Error", err.Error()))
	}
	defer os.RemoveAll(cwd)
	r, err := jsrt.Await(usage.RunLimited(bin, args, usage.RunOptions{Cwd: cwd, Env: env, TimeoutMs: statusTimeoutMs, MaxBytes: usage.StdoutLimit}))
	if err != nil {
		return nil
	}
	return &RunStatusResult{Stdout: r.Stdout, Code: r.Code}
}

func lower(s string) string { return util.JSLower(s) }

// ParseClaudeStatus = parseClaudeStatus（nil = null）。
func ParseClaudeStatus(stdout string) *util.Obj {
	start := strings.IndexByte(stdout, '{')
	if start < 0 {
		return nil
	}
	v, err := parseJSON(stdout[start:])
	if err != nil {
		return nil
	}
	if v == nil {
		panic(typeErr("Cannot read properties of null (reading 'loggedIn')"))
	}
	if prop(v, "loggedIn") != true {
		return util.NewObj("loggedIn", false)
	}
	out := util.NewObj("loggedIn", true)
	if email := strTrim(prop(v, "email")); email != "" {
		out.Set("email", email)
		out.Set("key", lower(email))
	}
	if p := strTrim(prop(v, "subscriptionType")); p != "" {
		out.Set("plan", p)
	}
	if o := strTrim(prop(v, "orgName")); o != "" {
		out.Set("org", o)
	}
	return out
}

// ClaudeIdentityFromConfig = claudeIdentityFromConfig（nil = null）。
func ClaudeIdentityFromConfig(configDir string, userDefault bool) *util.Obj {
	file := ""
	if usage.ExistsSync(filepath.Join(configDir, ".claude.json")) {
		file = filepath.Join(configDir, ".claude.json")
	} else if userDefault {
		file = filepath.Join(filepath.Dir(configDir), ".claude.json")
	}
	var oa any
	if file != "" {
		if j := readJSONObj(file); j != nil {
			oa = j.Get("oauthAccount")
		}
	}
	if !truthy(oa) {
		return nil
	}
	switch oa.(type) {
	case *util.Obj, []any:
	default:
		return nil
	}
	email := strTrim(prop(oa, "emailAddress"))
	key := strTrim(prop(oa, "accountUuid"))
	if key == "" && email != "" {
		key = lower(email)
	}
	out := util.NewObj("loggedIn", true)
	if email != "" {
		out.Set("email", email)
	}
	if key != "" {
		out.Set("key", key)
	}
	if o := strTrim(prop(oa, "organizationName")); o != "" {
		out.Set("org", o)
	}
	return out
}

var (
	loggedInRe    = regexp.MustCompile(`(?i)logged in`)
	notLoggedInRe = regexp.MustCompile(`(?i)not logged in`)
)

// ReadIdentity = readIdentity（持 jsrt 锁调用；panic(JSThrow) = 拒绝）。accountDir nil = null。
func ReadIdentity(kind string, accountDir *string, d IdentityDeps) *util.Obj {
	baseEnv := d.Env
	if baseEnv == nil {
		baseEnv = cli.WithCliPath(usage.ProcessEnv())
	}
	env := OfficialAccountEnv(kind, baseEnv, accountDir)
	run := d.Run
	if run == nil {
		run = runStatus
	}
	hasDir := accountDir != nil && *accountDir != ""
	switch kind {
	case "claude":
		r := run(kind, []string{"auth", "status", "--json"}, env)
		var parsed *util.Obj
		if r != nil {
			parsed = ParseClaudeStatus(r.Stdout)
		}
		if parsed != nil {
			return parsed
		}
		dir := ""
		if accountDir != nil {
			dir = *accountDir
		} else {
			dir = UserCliHome("claude", baseEnv, d.Home)
		}
		if id := ClaudeIdentityFromConfig(dir, !hasDir); id != nil {
			return id
		}
		return util.NewObj("loggedIn", false)
	case "codex":
		via := d.CodexAccount
		if via == nil && d.Run == nil {
			via = func(env *util.Obj, args []string, w bool) (*CodexAccountInfo, error) {
				return ReadCodexAccount(env, args, w, CodexAccountDeps{}), nil
			}
		}
		var acct *CodexAccountInfo
		if via != nil {
			func() {
				defer func() {
					if r := recover(); r != nil {
						if _, ok := r.(jsrt.JSThrow); !ok {
							panic(r)
						}
						acct = nil
					}
				}()
				a, err := via(env, OfficialAccountArgs("codex", accountDir), d.WithAccountID)
				if err == nil {
					acct = a
				}
			}()
		}
		if acct != nil {
			return CodexIdentity(acct, d.WithAccountID)
		}
		r := run(kind, []string{"login", "status"}, env)
		text := ""
		if r != nil {
			text = r.Stdout
		}
		return util.NewObj("loggedIn", loggedInRe.MatchString(text) && !notLoggedInRe.MatchString(text))
	case "grok":
		g := d.GrokAuth
		if g == nil {
			g = func(e *util.Obj) (string, bool) {
				return usage.ReadGrokAuthStatus(usage.GrokAuthReaderDeps{Env: func() *util.Obj { return e }})
			}
		}
		mode, ok := g(env)
		return util.NewObj("loggedIn", ok && mode == "cached_token")
	}
	root := ""
	if accountDir != nil {
		root = *accountDir
	} else {
		root = UserCliHome("gemini", baseEnv, d.Home)
	}
	accts := readJSONObj(filepath.Join(root, ".gemini", "google_accounts.json"))
	email := strTrim(accts.Get("active"))
	out := util.NewObj("loggedIn", usage.ExistsSync(filepath.Join(root, ".gemini", "oauth_creds.json")))
	if email != "" {
		out.Set("email", email)
		out.Set("key", lower(email))
	}
	return out
}

// CodexIdentity = codexIdentity.
func CodexIdentity(a *CodexAccountInfo, withAccountID bool) *util.Obj {
	if !a.LoggedIn {
		return util.NewObj("loggedIn", false)
	}
	email := lower(a.Email)
	var parts []string
	if email != "" {
		parts = append(parts, email)
	}
	if a.AccountID != "" {
		parts = append(parts, a.AccountID)
	}
	key := strings.Join(parts, "|")
	out := util.NewObj("loggedIn", true)
	if a.Email != "" {
		out.Set("email", a.Email)
	}
	if a.Plan != "" {
		out.Set("plan", a.Plan)
	}
	if key != "" {
		out.Set("key", key)
	}
	if a.AccountID != "" {
		out.Set("accountId", a.AccountID)
	}
	if withAccountID {
		out.Set("accountIdChecked", true)
	}
	return out
}
