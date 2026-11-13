package accounts

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

const loginTimeoutMs = 15 * 60_000

var (
	osc8Re  = regexp.MustCompile("\x1b\\]8;;[^\x07\x1b]*(?:\x07|\x1b\\\\)")
	csiRe   = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")
	oscRe   = regexp.MustCompile("\x1b\\][^\x07]*\x07")
	urlRe   = regexp.MustCompile(`https://[^\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}"'<>]+`)
	code1Re = util.JSRe(`(?i)one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})`)
	code2Re = util.JSRe(`(?i)Confirm this code[^\n]*\n\s*\n?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})`)
	pasteRe = regexp.MustCompile(`(?i)Paste code here`)
)

// StripTerminal = stripTerminal.
func StripTerminal(s string) string {
	s = osc8Re.ReplaceAllString(s, "")
	s = csiRe.ReplaceAllString(s, "")
	return oscRe.ReplaceAllString(s, "")
}

// ParseLoginOutput = parseLoginOutput（键序 url?, code?, needsCode）。
func ParseLoginOutput(raw string) *util.Obj {
	text := StripTerminal(raw)
	o := util.NewObj()
	if m := urlRe.FindString(text); m != "" {
		o.Set("url", m)
	}
	code := ""
	if m := code1Re.FindStringSubmatch(text); m != nil {
		code = m[1]
	} else if m := code2Re.FindStringSubmatch(text); m != nil {
		code = m[1]
	}
	if code != "" {
		o.Set("code", code)
	}
	o.Set("needsCode", pasteRe.MatchString(text))
	return o
}

type loginSession struct {
	id, kind, accountID string
	created             bool
	cwd                 string
	child               *nodeproc.Child
	out                 string
	last                *util.Obj
	timer               *jsrt.Timer
	finished            bool
}

// LoginDeps = AccountLogin 构造参数。
type LoginDeps struct {
	Accounts     *AccountService
	Emit         func(e *util.Obj)
	OpenExternal func(url string) error
	Logger       deps.Logger
	TimeoutMs    int
}

// AccountLogin = AccountLogin（方法持 jsrt 锁调用）。
type AccountLogin struct {
	d        LoginDeps
	sessions map[string]*loginSession
	order    []string
}

func NewAccountLogin(d LoginDeps) *AccountLogin {
	return &AccountLogin{d: d, sessions: map[string]*loginSession{}}
}

func (l *AccountLogin) send(s *loginSession, e *util.Obj) {
	ev := util.NewObj("id", s.id, "kind", s.kind)
	for _, k := range e.Keys() {
		ev.Set(k, e.Get(k))
	}
	s.last = ev
	l.d.Emit(ev)
}

func (l *AccountLogin) delSession(id string) {
	delete(l.sessions, id)
	for i, x := range l.order {
		if x == id {
			l.order = append(l.order[:i], l.order[i+1:]...)
			return
		}
	}
}

func errMessage(err error) string {
	switch e := err.(type) {
	case jsrt.JSThrow:
		return e.Message
	case *jsrt.JSThrow:
		return e.Message
	}
	return err.Error()
}

var loginNodeExec = func() string {
	if p := os.Getenv("NOMI_NODE_BIN"); p != "" {
		return p
	}
	return "node"
}

// Start = start(kind, accountId)（accountId nil = undefined）。
func (l *AccountLogin) Start(kind string, accountID *string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (ev *util.Obj, err error) {
		defer catchJS(&err)
		if !isKind(kind) {
			// resolveCliBin 里 `for (const c of CANDIDATES[kind])` 的 TypeError
			panic(typeErr("CANDIDATES[kind] is not iterable"))
		}
		bin := harness.ResolveHarnessBin(kind)
		if bin == "" {
			panic(jsThrow("Error", t("electron.common.isn-t-installed-yet-install-it-first", kind)))
		}
		created := accountID == nil
		var account string
		if accountID != nil {
			account = *accountID
		} else {
			account = jsStr(l.d.Accounts.create(kind, undef).Get("id"))
		}
		if _, err := jsrt.Await(l.d.Accounts.PrepareLogin(account)); err != nil {
			return nil, err
		}
		target := l.d.Accounts.loginTarget(account)
		if target.Kind != kind {
			panic(jsThrow("Error", t("electron.common.account-not-found")))
		}
		id := account
		if _, ok := l.sessions[id]; ok {
			l.Cancel(id)
		}
		// 登录用的 CLI 不在账号目录里跑：工作目录在账号目录里时，lsof 会把它（和它拉起的原生程序）
		// 算成「在用这个账号的进程」，登录卡住 / 没退干净时账号就删不掉。用一个空的临时目录。
		cwd := os.TempDir()
		if d, err := os.MkdirTemp("", "nomi-acct-login-"); err == nil {
			cwd = d
		}
		args := LoginArgs(kind)
		script := harness.IsScript(bin)
		extra := util.NewObj()
		if script {
			extra.Set("ELECTRON_RUN_AS_NODE", "1")
		}
		env := cli.BuildCliEnv(target.Env, extra)
		file, argv := bin, args
		if script {
			file, argv = loginNodeExec(), append([]string{bin}, args...)
		}
		launch := cli.ResolveHarnessLaunch(file, argv, env, usage.Platform(), nil)
		child := nodeproc.Spawn(launch.File, launch.Args, nodeproc.Options{Cwd: cwd, Env: usage.EnvSlice(launch.Env), Verbatim: launch.Verbatim})
		s := &loginSession{id: id, kind: kind, accountID: account, created: created, cwd: cwd, child: child,
			last: util.NewObj("id", id, "kind", kind, "state", "starting")}
		tm := l.d.TimeoutMs
		if tm == 0 {
			tm = loginTimeoutMs
		}
		s.timer = jsrt.SetTimeout(time.Duration(tm)*time.Millisecond, func() {
			l.fail(s, t("electron.common.sign-in-timed-out-try-again"))
		})
		l.sessions[id] = s
		l.order = append(l.order, id)
		onData := func(c string) {
			s.out += c
			if n := len16(s.out); n > 64*1024 {
				s.out = slice16(s.out, n-64*1024, n)
			}
			p := ParseLoginOutput(s.out)
			if s.last.Get("state") == "verifying" {
				return
			}
			if p.Has("url") || p.Has("code") || p.Get("needsCode") == true {
				e := util.NewObj("state", "waiting")
				for _, k := range p.Keys() {
					e.Set(k, p.Get(k))
				}
				l.send(s, e)
			}
		}
		child.OnStdout(onData)
		child.OnStderr(onData)
		child.OnError(func(e error) { l.fail(s, errMessage(e)) })
		child.OnClose(func(code *int, _ string) { l.onExit(s, code) })
		l.d.Emit(s.last)
		return s.last, nil
	})
}

func (l *AccountLogin) collect(s *loginSession) {
	if s.finished {
		return
	}
	s.finished = true
	account, err := jsrt.Await(l.d.Accounts.Refresh(s.accountID))
	if err == nil && account.Get("loggedIn") != true && !truthy(account.Get("loggedIn")) {
		err = jsThrow("Error", t("electron.common.sign-in-finished-but-the-cli-still-reports"))
	}
	if err != nil {
		l.send(s, util.NewObj("state", "error", "message", errMessage(err)))
		l.cleanup(s, true)
		return
	}
	l.send(s, util.NewObj("state", "done", "account", account))
	l.cleanup(s, false)
}

// Input = input(id, text).
func (l *AccountLogin) Input(id string, text any) bool {
	s := l.sessions[id]
	if s == nil || s.finished || !s.child.Stdin.Writable() {
		return false
	}
	s.child.Stdin.Write(slice16(util.JSTrim(jsStr(text)), 0, 2000) + "\n")
	e := s.last.Clone()
	e.Set("state", "verifying")
	e.Set("needsCode", false)
	l.send(s, e)
	return true
}

// Cancel = cancel(id).
func (l *AccountLogin) Cancel(id string) bool {
	s := l.sessions[id]
	if s == nil || s.finished {
		return false
	}
	s.finished = true
	cli.KillProcessTree(clisdk.ProcChild{Child: s.child})
	l.send(s, util.NewObj("state", "cancelled"))
	l.cleanup(s, true)
	return true
}

func (l *AccountLogin) fail(s *loginSession, message string) {
	if s.finished {
		return
	}
	s.finished = true
	cli.KillProcessTree(clisdk.ProcChild{Child: s.child})
	ev := util.NewObj("state", "error", "message", message)
	if blockedRe.MatchString(StripTerminal(s.out)) || blockedRe.MatchString(message) {
		// 官方服务拒绝了这个网络（地区不受支持 / 代理没生效）：界面给出明显的提示和代理开关
		ev.Set("hint", "network-blocked")
		ev.Set("useShellProxy", cli.UseShellProxy())
		if p := cli.DetectedShellProxy(); p != "" {
			ev.Set("shellProxy", p)
		}
	}
	l.send(s, ev)
	l.cleanup(s, true)
}

// blockedRe：登录请求被官方服务以 403 拒绝（Codex 设备码：device code request failed with status 403 Forbidden）
var blockedRe = regexp.MustCompile(`(?i)status 403\b|403 Forbidden|unsupported_country`)

func (l *AccountLogin) onExit(s *loginSession, code *int) {
	if s.finished {
		return
	}
	if code == nil || *code != 0 {
		c := "null"
		if code != nil {
			c = jsStr(float64(*code))
		}
		l.fail(s, orStr(l.tail(s), t("electron.common.sign-in-didn-t-finish-exit-code", c)))
		return
	}
	jsrt.Async(func() (struct{}, error) {
		l.collect(s)
		return struct{}{}, nil
	})
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (l *AccountLogin) tail(s *loginSession) string {
	lines := strings.Split(util.JSTrim(StripTerminal(s.out)), "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return strings.Join(lines, "\n")
}

func (l *AccountLogin) cleanup(s *loginSession, failed bool) {
	jsrt.ClearTimeout(s.timer)
	l.delSession(s.id)
	if s.cwd != os.TempDir() && strings.HasPrefix(filepath.Base(s.cwd), "nomi-acct-login-") {
		dir := s.cwd
		if s.child.ExitCode() == nil && s.child.SignalCode() == "" {
			s.child.OnClose(func(*int, string) { _ = os.RemoveAll(dir) })
		} else {
			_ = os.RemoveAll(dir)
		}
	}
	if !failed || !s.created {
		return
	}
	drop := func() {
		p := l.d.Accounts.Remove(s.accountID, true)
		jsrt.Async(func() (struct{}, error) {
			if _, err := jsrt.Await(p); err != nil && l.d.Logger != nil {
				l.d.Logger.Warn("login account cleanup failed", errString(err))
			}
			return struct{}{}, nil
		})
	}
	if s.child.ExitCode() == nil && s.child.SignalCode() == "" {
		once := false
		s.child.OnClose(func(*int, string) {
			if !once {
				once = true
				drop()
			}
		})
	} else {
		drop()
	}
}

// Dispose = dispose.
func (l *AccountLogin) Dispose() {
	for _, id := range append([]string(nil), l.order...) {
		l.Cancel(id)
	}
}

// OpenURL = openUrl.
func (l *AccountLogin) OpenURL(raw string) (bool, error) {
	if !IsLoginURL(raw) {
		return false, nil
	}
	if l.d.OpenExternal != nil {
		if err := l.d.OpenExternal(raw); err != nil {
			return false, err
		}
	}
	return true, nil
}

var loginHosts = []string{"claude.com", "claude.ai", "anthropic.com", "auth.openai.com", "accounts.x.ai", "auth.x.ai", "accounts.google.com"}

// IsLoginURL = isLoginUrl.
func IsLoginURL(raw string) bool {
	u, err := url.Parse(util.JSTrim(raw))
	if err != nil || !strings.EqualFold(u.Scheme, "https") {
		return false
	}
	h := strings.ToLower(u.Hostname())
	for _, x := range loginHosts {
		if h == x || strings.HasSuffix(h, "."+x) {
			return true
		}
	}
	return false
}

// LoginBroadcaster = loginBroadcaster.
func LoginBroadcaster(events deps.Events) func(e *util.Obj) {
	return func(e *util.Obj) { events.Publish("cliAccount.login", e) }
}
