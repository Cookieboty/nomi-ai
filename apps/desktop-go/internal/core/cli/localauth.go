package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodepath"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

const (
	defaultLocalAuthTimeoutMs = 15 * 60_000
	defaultLocalAuthProbeMs   = 15_000
)

var (
	localAuthOsc8Re     = regexp.MustCompile("\x1b\\]8;;[^\x07\x1b]*(?:\x07|\x1b\\\\)")
	localAuthCsiRe      = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")
	localAuthOscRe      = regexp.MustCompile("\x1b\\][^\x07]*\x07")
	localAuthURLRe      = regexp.MustCompile(`https://[^\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}"'<>]+`)
	localAuthBlockedRe  = regexp.MustCompile(`(?i)status 403\b|403 Forbidden|unsupported_country`)
	localAuthRequiredRe = regexp.MustCompile(`(?i)auth_required|authentication\s+required|not\s+authenticated|unauthenticated|login\s+required|please\s+log\s+in|-32000`)
)

// LocalAuthDeps configures LocalAuthService for local-only CLIs that delegate sign-in/logout to the CLI itself.
type LocalAuthDeps struct {
	ResolveBin func(kind string) string
	Emit       func(e *util.Obj)
	OnChanged  func(kind string)
	TimeoutMs  int
	ProbeMs    int
}

type localAuthSession struct {
	id, kind string
	cwd      string
	child    *nodeproc.Child
	out      string
	lastURL  string
	last     *util.Obj
	timer    *jsrt.Timer
	finished bool
}

// LocalAuthService manages official CLI login/logout for supported local-only CLIs without touching keychains or secrets.
// All public methods run under jsrt's single-thread lock convention.
type LocalAuthService struct {
	d        LocalAuthDeps
	sessions map[string]*localAuthSession
	order    []string
	seq      int64
	probeGen map[string]int64
}

// LocalAuthSupported reports whether kind supports in-app local official sign-in management.
func LocalAuthSupported(kind string) bool {
	return kind == "antigravity"
}

// NewLocalAuthService constructs a LocalAuthService.
func NewLocalAuthService(d LocalAuthDeps) *LocalAuthService {
	return &LocalAuthService{
		d:        d,
		sessions: map[string]*localAuthSession{},
		probeGen: map[string]int64{},
	}
}

// Supported reports whether kind supports in-app local official sign-in management.
func (s *LocalAuthService) Supported(kind string) bool {
	return LocalAuthSupported(kind)
}

func (s *LocalAuthService) resolveBin(kind string) string {
	if s.d.ResolveBin != nil {
		return s.d.ResolveBin(kind)
	}
	if p := ResolveCliBinCached(kind); p != "" {
		return p
	}
	return ResolveLauncherBin(kind)
}

func (s *LocalAuthService) probeMs() int {
	if s.d.ProbeMs > 0 {
		return s.d.ProbeMs
	}
	return defaultLocalAuthProbeMs
}

func (s *LocalAuthService) loginTimeoutMs() int {
	if s.d.TimeoutMs > 0 {
		return s.d.TimeoutMs
	}
	return defaultLocalAuthTimeoutMs
}

func (s *LocalAuthService) bumpGen(kind string) int64 {
	s.probeGen[kind] = s.probeGen[kind] + 1
	return s.probeGen[kind]
}

func (s *LocalAuthService) emit(e *util.Obj) {
	if s.d.Emit != nil {
		s.d.Emit(e)
	}
}

func (s *LocalAuthService) emitChanged(kind string) {
	if s.d.OnChanged != nil {
		s.d.OnChanged(kind)
	}
}

func (s *LocalAuthService) spawn(bin string, args []string, cwd string) *nodeproc.Child {
	lower := strings.ToLower(bin)
	script := strings.HasSuffix(lower, ".mjs") || strings.HasSuffix(lower, ".js")
	extra := util.NewObj()
	file, argv := bin, append([]string(nil), args...)
	if script {
		extra.Set("ELECTRON_RUN_AS_NODE", "1")
		node := ResolveNodeBin()
		if node == "" {
			node = "node"
		}
		file, argv = node, append([]string{bin}, argv...)
	}
	base, _ := ScrubSecretEnv(WithCliPath(usage.ProcessEnv()), nil)
	env := BuildCliEnv(base, extra)
	launch := ResolveHarnessLaunch(file, argv, env, usage.Platform(), nil)
	return nodeproc.Spawn(launch.File, launch.Args, nodeproc.Options{
		Cwd:      cwd,
		Env:      usage.EnvSlice(launch.Env),
		Verbatim: launch.Verbatim,
	})
}

func localAuthWithTimeout[T any](child *nodeproc.Child, timeoutMs int, run func(done func(T), fail func(error))) *jsrt.Promise[T] {
	p := jsrt.NewPromise[T]()
	settled := false
	var timer *jsrt.Timer
	finish := func(fn func()) {
		if settled {
			return
		}
		settled = true
		jsrt.ClearTimeout(timer)
		func() {
			defer func() { _ = recover() }()
			KillProcessTree(clisdk.ProcChild{Child: child})
		}()
		fn()
	}
	timer = jsrt.SetTimeout(time.Duration(timeoutMs)*time.Millisecond, func() {
		finish(func() { p.Reject(fmt.Errorf("timed out after %dms", timeoutMs)) })
	})
	child.OnError(func(e error) { finish(func() { p.Reject(e) }) })
	run(func(v T) { finish(func() { p.Resolve(v) }) }, func(e error) { finish(func() { p.Reject(e) }) })
	return p
}

func stripLocalAuthTerminal(s string) string {
	s = localAuthOsc8Re.ReplaceAllString(s, "")
	s = localAuthCsiRe.ReplaceAllString(s, "")
	return localAuthOscRe.ReplaceAllString(s, "")
}

func lastNonEmptyLines(raw string, limit int) string {
	lines := strings.Split(util.JSTrim(stripLocalAuthTerminal(raw)), "\n")
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return util.JSTrim(strings.Join(lines, "\n"))
}

// Status reports official sign-in status for kind; when probe=true, runs ACP initialize + session/new to verify real auth state.
func (s *LocalAuthService) Status(kind string, probe bool) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if !LocalAuthSupported(kind) {
			return util.NewObj(
				"kind", kind,
				"loggedIn", false,
				"canLogin", false,
				"canLogout", false,
			), nil
		}
		bin := s.resolveBin(kind)
		if bin == "" {
			return util.NewObj(
				"kind", kind,
				"loggedIn", false,
				"canLogin", false,
				"canLogout", false,
				"detail", i18n.T("electron.common.isn-t-installed-yet-install-it-first", builtin.DisplayName(kind)),
			), nil
		}
		if !probe {
			loggedIn := DetectLocalLogin(kind, "")
			return util.NewObj(
				"kind", kind,
				"loggedIn", loggedIn,
				"canLogin", true,
				"canLogout", true,
			), nil
		}

		prevEffective := DetectLocalLogin(kind, "")
		cachedVal, hadCached := CachedLocalAuth(kind)
		gen := s.probeGen[kind]

		loggedIn, probeErr := jsrt.Await(s.probeACP(bin))
		if probeErr == nil {
			if s.probeGen[kind] == gen {
				SetLocalAuthCache(kind, loggedIn)
				if prevEffective != loggedIn {
					s.emitChanged(kind)
				}
			}
			return util.NewObj(
				"kind", kind,
				"loggedIn", loggedIn,
				"canLogin", true,
				"canLogout", true,
			), nil
		}

		if localAuthRequiredRe.MatchString(probeErr.Error()) {
			if s.probeGen[kind] == gen {
				SetLocalAuthCache(kind, false)
				if prevEffective {
					s.emitChanged(kind)
				}
			}
			return util.NewObj(
				"kind", kind,
				"loggedIn", false,
				"canLogin", true,
				"canLogout", true,
			), nil
		}

		// Transient error (timeout / network / unexpected exit): preserve any cached true state and fall back cleanly.
		fallback := prevEffective
		if hadCached && cachedVal {
			fallback = true
		}
		out := util.NewObj(
			"kind", kind,
			"loggedIn", fallback,
			"canLogin", true,
			"canLogout", true,
			"detail", rpc.InnermostMessage(probeErr.Error()),
		)
		return out, nil
	})
}

func (s *LocalAuthService) probeACP(bin string) *jsrt.Promise[bool] {
	probeMs := s.probeMs()
	child := s.spawn(bin, []string{"acp", "--disable-telemetry"}, os.TempDir())
	return localAuthWithTimeout[bool](child, probeMs, func(done func(bool), fail func(error)) {
		tail := ""
		child.OnStderr(func(c string) { tail = clisdk.SliceFrom(tail+c, -600) })
		conn := gemini.NewAcpConnection(clisdk.ProcChild{Child: child}, rpc.Handlers{
			OnNotification: func(string, rpc.Json) {},
			OnRequest: func(string, rpc.Json) *jsrt.Promise[any] {
				return jsrt.Rejected[any](errors.New("not supported"))
			},
		})
		opts := rpc.RequestOptions{TimeoutMs: &probeMs}
		jsrt.Async(func() (struct{}, error) {
			if _, err := jsrt.Await(conn.Request("initialize", util.NewObj("protocolVersion", float64(1), "clientCapabilities", util.NewObj()), opts)); err != nil {
				if msg := rpc.InnermostMessage(err.Error()); msg != "" {
					fail(err)
				} else if t := lastNonEmptyLines(tail, 3); t != "" {
					fail(errors.New(t))
				} else {
					fail(err)
				}
				return struct{}{}, nil
			}
			sv, err := jsrt.Await(conn.Request("session/new", util.NewObj("cwd", nodepath.Tmpdir(), "mcpServers", []any{}), opts))
			if err != nil {
				fail(err)
				return struct{}{}, nil
			}
			session := util.AsObj(sv)
			if sid, ok := session.Get("sessionId").(string); ok && sid != "" {
				closeMs := 1_500
				_, _ = jsrt.Await(conn.Request("session/close", util.NewObj("sessionId", sid), rpc.RequestOptions{TimeoutMs: &closeMs}))
			}
			done(true)
			return struct{}{}, nil
		})
	})
}

func (s *LocalAuthService) send(sess *localAuthSession, e *util.Obj) {
	ev := util.NewObj("id", sess.id, "kind", sess.kind)
	for _, k := range e.Keys() {
		ev.Set(k, e.Get(k))
	}
	sess.last = ev
	s.emit(ev)
}

func (s *LocalAuthService) delSession(id string) {
	delete(s.sessions, id)
	for i, x := range s.order {
		if x == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			return
		}
	}
}

func (s *LocalAuthService) cleanup(sess *localAuthSession) {
	jsrt.ClearTimeout(sess.timer)
	s.delSession(sess.id)
	if sess.cwd != os.TempDir() && strings.HasPrefix(filepath.Base(sess.cwd), "nomi-local-login-") {
		dir := sess.cwd
		if sess.child.ExitCode() == nil && sess.child.SignalCode() == "" {
			sess.child.OnClose(func(*int, string) { _ = os.RemoveAll(dir) })
		} else {
			_ = os.RemoveAll(dir)
		}
	}
}

func (s *LocalAuthService) fail(sess *localAuthSession, message string) {
	if sess.finished {
		return
	}
	sess.finished = true
	KillProcessTree(clisdk.ProcChild{Child: sess.child})
	ev := util.NewObj("state", "error", "message", message)
	if localAuthBlockedRe.MatchString(stripLocalAuthTerminal(sess.out)) || localAuthBlockedRe.MatchString(message) {
		ev.Set("hint", "network-blocked")
		ev.Set("useShellProxy", UseShellProxy())
		if p := DetectedShellProxy(); p != "" {
			ev.Set("shellProxy", p)
		}
	}
	s.send(sess, ev)
	s.cleanup(sess)
}

// StartLogin starts `<bin> acp --login` in an isolated temp dir and streams login events until done, cancelled, or error.
func (s *LocalAuthService) StartLogin(kind string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if !LocalAuthSupported(kind) {
			return nil, errors.New(i18n.T("electron.common.cli-local-auth-not-supported", kind))
		}
		bin := s.resolveBin(kind)
		if bin == "" {
			return nil, errors.New(i18n.T("electron.common.isn-t-installed-yet-install-it-first", builtin.DisplayName(kind)))
		}
		for _, id := range append([]string(nil), s.order...) {
			if existing := s.sessions[id]; existing != nil && existing.kind == kind {
				s.CancelLogin(id)
			}
		}
		cwd := os.TempDir()
		if d, err := os.MkdirTemp("", "nomi-local-login-"); err == nil {
			cwd = d
		}
		s.seq++
		id := fmt.Sprintf("local:%s:%d", kind, s.seq)
		child := s.spawn(bin, []string{"acp", "--login"}, cwd)
		sess := &localAuthSession{
			id:    id,
			kind:  kind,
			cwd:   cwd,
			child: child,
			last:  util.NewObj("id", id, "kind", kind, "state", "starting"),
		}
		sess.timer = jsrt.SetTimeout(time.Duration(s.loginTimeoutMs())*time.Millisecond, func() {
			s.fail(sess, i18n.T("electron.common.sign-in-timed-out-try-again"))
		})
		s.sessions[id] = sess
		s.order = append(s.order, id)

		onData := func(chunk string) {
			if sess.finished || sess.last.Get("state") == "verifying" {
				return
			}
			sess.out += chunk
			if len(sess.out) > 64*1024 {
				sess.out = sess.out[len(sess.out)-64*1024:]
			}
			text := stripLocalAuthTerminal(sess.out)
			if u := localAuthURLRe.FindString(text); u != "" && u != sess.lastURL {
				sess.lastURL = u
				s.send(sess, util.NewObj("state", "waiting", "url", u))
			}
		}
		child.OnStdout(onData)
		child.OnStderr(onData)
		child.OnError(func(e error) { s.fail(sess, e.Error()) })
		child.OnClose(func(code *int, _ string) {
			if sess.finished {
				return
			}
			if code == nil || *code != 0 {
				c := "null"
				if code != nil {
					c = fmt.Sprint(*code)
				}
				msg := lastNonEmptyLines(sess.out, 3)
				if msg == "" {
					msg = i18n.T("electron.common.sign-in-didn-t-finish-exit-code", c)
				}
				s.fail(sess, msg)
				return
			}
			s.send(sess, util.NewObj("state", "verifying"))
			jsrt.Async(func() (struct{}, error) {
				if sess.finished {
					return struct{}{}, nil
				}
				status, err := jsrt.Await(s.Status(kind, true))
				if sess.finished {
					return struct{}{}, nil
				}
				if err == nil && util.Truthy(status.Get("loggedIn")) {
					sess.finished = true
					s.emitChanged(kind)
					s.send(sess, util.NewObj("state", "done"))
					s.cleanup(sess)
					return struct{}{}, nil
				}
				msg := i18n.T("electron.common.sign-in-finished-but-the-cli-still-reports")
				if err != nil {
					msg = err.Error()
				}
				s.fail(sess, msg)
				return struct{}{}, nil
			})
		})
		s.emit(sess.last)
		return sess.last, nil
	})
}

// CancelLogin aborts an in-progress local login session and kills its child process tree.
func (s *LocalAuthService) CancelLogin(id string) bool {
	sess := s.sessions[id]
	if sess == nil || sess.finished {
		return false
	}
	sess.finished = true
	KillProcessTree(clisdk.ProcChild{Child: sess.child})
	s.send(sess, util.NewObj("state", "cancelled"))
	s.cleanup(sess)
	return true
}

// Logout runs ACP initialize followed by `"logout"` on the local CLI, clears cache, and notifies listeners.
func (s *LocalAuthService) Logout(kind string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if !LocalAuthSupported(kind) {
			return nil, errors.New(i18n.T("electron.common.cli-local-auth-not-supported", kind))
		}
		bin := s.resolveBin(kind)
		if bin == "" {
			return nil, errors.New(i18n.T("electron.common.isn-t-installed-yet-install-it-first", builtin.DisplayName(kind)))
		}
		s.bumpGen(kind)
		probeMs := s.probeMs()
		child := s.spawn(bin, []string{"acp", "--disable-telemetry"}, os.TempDir())
		_, err := jsrt.Await(localAuthWithTimeout[struct{}](child, probeMs, func(done func(struct{}), fail func(error)) {
			tail := ""
			child.OnStderr(func(c string) { tail = clisdk.SliceFrom(tail+c, -600) })
			conn := gemini.NewAcpConnection(clisdk.ProcChild{Child: child}, rpc.Handlers{
				OnNotification: func(string, rpc.Json) {},
				OnRequest: func(string, rpc.Json) *jsrt.Promise[any] {
					return jsrt.Rejected[any](errors.New("not supported"))
				},
			})
			opts := rpc.RequestOptions{TimeoutMs: &probeMs}
			jsrt.Async(func() (struct{}, error) {
				if _, err := jsrt.Await(conn.Request("initialize", util.NewObj("protocolVersion", float64(1), "clientCapabilities", util.NewObj()), opts)); err != nil {
					if msg := rpc.InnermostMessage(err.Error()); msg != "" {
						fail(err)
					} else if t := lastNonEmptyLines(tail, 3); t != "" {
						fail(errors.New(t))
					} else {
						fail(err)
					}
					return struct{}{}, nil
				}
				if _, err := jsrt.Await(conn.Request("logout", util.NewObj(), opts)); err != nil {
					fail(err)
					return struct{}{}, nil
				}
				done(struct{}{})
				return struct{}{}, nil
			})
		}))
		if err != nil {
			return nil, err
		}
		s.bumpGen(kind)
		SetLocalAuthCache(kind, false)
		s.emitChanged(kind)
		return util.NewObj("loggedIn", false), nil
	})
}

// Dispose cancels all active local login sessions.
func (s *LocalAuthService) Dispose() {
	for _, id := range append([]string(nil), s.order...) {
		s.CancelLogin(id)
	}
}
