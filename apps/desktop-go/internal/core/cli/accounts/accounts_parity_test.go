package accounts

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// golden：scripts/parity/record-b7s-accounts.mjs（场景 testdata/b7s-accounts-scenarios.json，假 CLI testdata/b7s-accounts-cli.mjs）。

var acctKinds = []string{"claude", "codex", "grok", "gemini"}

type acctLog struct{ calls *[]any }

func first(d []any) any {
	if len(d) == 0 {
		return nil
	}
	return nilIfUndef(d[0])
}
func (l acctLog) Info(m string, d ...any) { *l.calls = append(*l.calls, []any{"info", m, first(d)}) }
func (l acctLog) Warn(m string, d ...any) { *l.calls = append(*l.calls, []any{"warn", m, first(d)}) }

type acctEvents struct{ calls *[]any }

func (e acctEvents) Publish(ev string, p any) { *e.calls = append(*e.calls, []any{"publish", ev, p}) }

type acctKeychain struct{ calls *[]any }

func (k acctKeychain) Get(s, a string) *jsrt.Promise[*string] {
	return jsrt.Async(func() (*string, error) { return nil, nil })
}
func (k acctKeychain) Set(s, a, v string) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) { return struct{}{}, nil })
}
func (k acctKeychain) Remove(s, a string) *jsrt.Promise[struct{}] {
	*k.calls = append(*k.calls, []any{"keychain.remove", s, a})
	return jsrt.Async(func() (struct{}, error) { return struct{}{}, nil })
}

func nilIfUndef(v any) any {
	if _, ok := v.(util.JSUndefined); ok {
		return nil
	}
	return v
}

func jsErr(err error) string {
	var ae *AccountError
	if errors.As(err, &ae) {
		return "AccountError: " + ae.Message
	}
	var jt jsrt.JSThrow
	if errors.As(err, &jt) {
		return jt.Name + ": " + jt.Message
	}
	var jp *jsrt.JSThrow
	if errors.As(err, &jp) {
		return jp.Name + ": " + jp.Message
	}
	return "Error: " + err.Error()
}

var (
	acctUUIDRe = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	acctKcRe   = regexp.MustCompile(`credentials-[0-9a-f]{8}"`)
	acctTmpRe  = regexp.MustCompile(`(nomi-[a-z]+(?:-[a-z]+)*-)[A-Za-z0-9]{6}"`)
	acctRefRe  = regexp.MustCompile(`\$d(\d+):(\w+)`)
)

func TestAccountsGolden(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("b7s-accounts golden is recorded on linux (fake CLIs are shebang node scripts)")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		paritytest.SkipOrFail(t, "node not found")
	}
	gp, _ := paritytest.Golden(t, "b7s-accounts.json", filepath.Join("testdata", "b7s-accounts.json"))
	gb, err := os.ReadFile(gp)
	if err != nil {
		t.Fatal(err)
	}
	sb, err := os.ReadFile(filepath.Join("testdata", "b7s-accounts-scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	mock, err := os.ReadFile(filepath.Join("testdata", "b7s-accounts-cli.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	gv, _ := util.ParseString(string(gb))
	sv, _ := util.ParseString(string(sb))
	golden := gv.(*util.Obj).Get("scenarios").([]any)
	scens := sv.([]any)
	if len(golden) != len(scens) {
		t.Fatalf("golden has %d scenarios, fixture %d — re-record", len(golden), len(scens))
	}
	bin := t.TempDir()
	for _, k := range acctKinds {
		f := filepath.Join(bin, k+".mjs")
		if err := os.WriteFile(f, []byte(strings.ReplaceAll(string(mock), "@@KIND@@", k)), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("NOMI_"+strings.ToUpper(k)+"_BIN", f)
	}
	t.Setenv("NOMI_NODE_BIN", node)
	steps := 0
	for i, s := range scens {
		sc := s.(*util.Obj)
		g := golden[i].(*util.Obj)
		if g.Get("name") != sc.Get("name") {
			t.Fatalf("scenario %d name mismatch", i)
		}
		steps += len(sc.Get("steps").([]any))
		t.Run(sc.Get("name").(string), func(t *testing.T) { runAcctScenario(t, sc, g.Get("out").([]any), bin) })
	}
	t.Logf("b7s-accounts: %d scenarios, %d steps", len(scens), steps)
}

func strOrEmpty(v any) string { s, _ := v.(string); return s }

func runAcctScenario(t *testing.T, sc *util.Obj, want []any, bin string) {
	SB := t.TempDir()
	if r, err := filepath.EvalSymlinks(SB); err == nil {
		SB = r
	}
	esc := func(s string) string { j := util.Stringify(s); return j[1 : len(j)-1] }
	sub := func(v any) any {
		x, _ := util.ParseString(strings.ReplaceAll(util.Stringify(v), "@@SB@@", esc(SB)))
		return x
	}
	for _, k := range acctKinds {
		_ = os.Remove(filepath.Join(bin, k+".mode.json"))
		_ = os.Remove(filepath.Join(bin, k+".log"))
		_ = os.Remove(filepath.Join(bin, k+".input"))
	}
	if fs, ok := sc.Get("files").([]any); ok {
		for _, f := range sub(fs).([]any) {
			o := f.(*util.Obj)
			p := filepath.Join(append([]string{SB}, strings.Split(o.Get("p").(string), "/")...)...)
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			if txt, ok := o.Get("text").(string); ok {
				_ = os.WriteFile(p, []byte(txt), 0o644)
			}
		}
	}
	d0, _ := sc.Get("deps").(*util.Obj)
	if d0 == nil {
		d0 = util.NewObj()
	}
	calls := []any{}
	events := []any{}
	inUse := map[string]any{}
	var live any = util.NewObj("state", "free")
	if v := d0.Get("live"); v != nil && v != util.Undefined {
		live = v
	}
	ids := []string{}
	env := util.NewObj("PATH", os.Getenv("PATH"), "HOME", SB+"/home", "USER", "tester")
	platform := "linux"
	if p, ok := d0.Get("platform").(string); ok {
		platform = p
	}
	mk := func() *AccountService {
		d := ServiceDeps{
			Root: SB + "/root", Logger: acctLog{&calls}, Events: acctEvents{&calls}, Env: env, Home: SB + "/home",
			Platform: platform, Keychain: acctKeychain{&calls},
			Now:              func() float64 { return 1700000000000 },
			OnDefaultChanged: func(k string) { calls = append(calls, []any{"defaultChanged", k}) },
			InUse: func(k, id string) any {
				if v, ok := inUse[id]; ok {
					return v
				}
				return 0.0
			},
			OnChanged: func() { calls = append(calls, []any{"changed"}) },
			LiveProcesses: func(k, dir string) (LiveCheck, error) {
				calls = append(calls, []any{"live", k, dir})
				if live == "throw" {
					return LiveCheck{}, errors.New("lsof boom")
				}
				o := live.(*util.Obj)
				lc := LiveCheck{State: o.Get("state").(string)}
				if ps, ok := o.Get("pids").([]any); ok {
					for _, p := range ps {
						lc.Pids = append(lc.Pids, p.(float64))
					}
				}
				return lc, nil
			},
		}
		if hv, ok := d0.Get("injectLogout").(string); ok {
			throws := d0.Get("logoutThrows") == true
			d.Logout = func(k string, e *util.Obj) error {
				var h any = nil
				if e.Has(hv) {
					h = e.Get(hv)
				}
				calls = append(calls, []any{"logout", k, h})
				if throws {
					return errors.New("logout boom")
				}
				return nil
			}
		}
		s, err := NewAccountService(d)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	var svc *AccountService
	var login *AccountLogin
	mkLogin := func() *AccountLogin {
		d := LoginDeps{
			Accounts: svc,
			Emit: func(e *util.Obj) {
				x, _ := util.ParseString(util.Stringify(e))
				events = append(events, x)
			},
			OpenExternal: func(u string) error { calls = append(calls, []any{"open", u}); return nil },
			Logger:       acctLog{&calls},
		}
		if ms, ok := d0.Get("timeoutMs").(float64); ok {
			d.TimeoutMs = int(ms)
		}
		return NewAccountLogin(d)
	}
	jsrt.Run(func() { svc = mk(); login = mkLogin() })
	ref := func(v any) any {
		s, ok := v.(string)
		if !ok {
			return v
		}
		if m := regexp.MustCompile(`^\$(\d+)$`).FindStringSubmatch(s); m != nil {
			n := int(m[1][0] - '0')
			if len(m[1]) > 1 {
				n = 0
				for _, c := range m[1] {
					n = n*10 + int(c-'0')
				}
			}
			if n-1 < len(ids) {
				return ids[n-1]
			}
			return util.Undefined
		}
		return acctRefRe.ReplaceAllStringFunc(s, func(x string) string {
			m := acctRefRe.FindStringSubmatch(x)
			n := 0
			for _, c := range m[1] {
				n = n*10 + int(c-'0')
			}
			return AccountDirFor(SB+"/root", m[2], ids[n-1])
		})
	}
	note := func(r *util.Obj) {
		if r == nil {
			return
		}
		if id, ok := r.Get("id").(string); ok && regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(id) {
			for _, x := range ids {
				if x == id {
					return
				}
			}
			ids = append(ids, id)
		}
	}
	strp := func(v any) *string {
		if s, ok := v.(string); ok {
			return &s
		}
		return nil
	}
	hasEvent := func(state string) bool {
		for _, e := range events {
			if e.(*util.Obj).Get("state") == state {
				return true
			}
		}
		return false
	}
	out := []any{}
	for _, raw := range sc.Get("steps").([]any) {
		st := sub(raw).([]any)
		op := st[0].(string)
		a := make([]any, 0, len(st)-1)
		for _, x := range st[1:] {
			a = append(a, ref(x))
		}
		arg := func(i int) any {
			if i < len(a) {
				return a[i]
			}
			return util.Undefined
		}
		s := func(i int) string { return strOrEmpty(arg(i)) }
		var r any = util.Undefined
		var err error
		jsrt.Run(func() {
			switch op {
			case "list":
				r, err = svc.List(s(0))
			case "create":
				var o *util.Obj
				o, err = svc.Create(s(0), arg(1))
				note(o)
				r = o
			case "rename":
				r, err = svc.Rename(s(0), arg(1))
			case "setDefault":
				r, err = svc.SetDefault(s(0), s(1))
			case "defaultId":
				r, err = svc.DefaultID(s(0))
			case "defaultDir":
				r, err = svc.DefaultDir(s(0))
			case "launch":
				var l OfficialLaunch
				l, err = svc.OfficialLaunch(s(0), strp(arg(1)))
				if err == nil {
					var dir any
					if l.Dir != nil {
						dir = *l.Dir
					}
					r = util.NewObj("dir", dir, "env", l.Env, "strip", strs(l.Strip), "args", strs(l.Args), "sig", l.Sig, "problems", problemsJSON(l.Problems))
				}
			case "resolve":
				r, err = svc.Resolve(s(0), strp(arg(1)))
			case "identityKey":
				r, err = svc.IdentityKey(s(0), strp(arg(1)))
			case "loginTarget":
				var lt LoginTarget
				lt, err = svc.LoginTarget(s(0))
				if err == nil {
					e := util.NewObj()
					for _, k := range arg(1).([]any) {
						var v any
						if lt.Env.Has(k.(string)) {
							v = lt.Env.Get(k.(string))
						}
						e.Set(k.(string), v)
					}
					var dir any
					if lt.Dir != nil {
						dir = *lt.Dir
					}
					r = util.NewObj("kind", lt.Kind, "dir", dir, "env", e)
				}
			case "refresh":
				r, err = jsrt.Await(svc.Refresh(s(0)))
			case "refreshAll":
				r, err = jsrt.Await(svc.RefreshAll(s(0)))
			case "remove":
				_, err = jsrt.Await(svc.Remove(s(0), arg(1) == true))
			case "prepareLogin":
				_, err = jsrt.Await(svc.PrepareLogin(s(0)))
			case "find":
				r, err = undefIfNil(svc.FindByAccountID(s(0), s(1)))
			case "note":
				err = svc.NoteSession(s(0), s(1), strp(arg(2)))
			case "noteMany":
				for i := 0; i < int(arg(1).(float64)); i++ {
					_ = svc.NoteSession(s(0), "m"+itoa(i), strp(arg(2)))
				}
			case "sessionsSummary":
				b, _ := os.ReadFile(s(0))
				jv, _ := util.ParseString(string(b))
				j := jv.(*util.Obj)
				ss := j.Get("sessions").([]any)
				r = util.NewObj("keys", strs(j.Keys()), "n", float64(len(ss)), "first", ss[0], "last", ss[len(ss)-1])
			case "histLabel":
				r, err = svc.HistoryAccountLabel(s(0), s(1))
				if r == nil && err == nil {
					r = util.Undefined
				}
			case "histSession":
				r, err = undefIfNil(svc.HistorySessionAccount(s(0), s(1)))
			case "sessionAccount":
				r, err = undefIfNil(svc.SessionAccount(s(0), s(1)))
			case "broadcast":
				svc.BroadcastChanged()
			case "parseKind":
				r, err = ParseAccountKind(arg(0))
			case "precheck":
				r = PrecheckMessage(s(0))
			case "inUse":
				inUse[s(0)] = arg(1)
			case "live":
				live = arg(0)
			case "mode":
				_ = os.WriteFile(filepath.Join(bin, s(0)+".mode.json"), []byte(util.Stringify(arg(1))), 0o644)
			case "cliLog":
				f := filepath.Join(bin, s(0)+".log")
				lines := []any{}
				if b, e := os.ReadFile(f); e == nil {
					for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
						x, _ := util.ParseString(l)
						lines = append(lines, x)
					}
				}
				_ = os.Remove(f)
				r = lines
			case "reload":
				svc = mk()
				login = mkLogin()
			case "idle":
				_, err = jsrt.Await(utils.WhenPrivateWritesIdle())
			case "tick":
				ms := 50.0
				if v, ok := arg(0).(float64); ok {
					ms = v
				}
				jsrt.Sleep(time.Duration(ms) * time.Millisecond)
			case "calls":
				r = calls
				calls = []any{}
			case "write":
				_ = os.MkdirAll(filepath.Dir(s(0)), 0o755)
				_ = os.WriteFile(s(0), []byte(s(1)), 0o644)
			case "read", "readBin":
				p := s(0)
				if op == "readBin" {
					p = filepath.Join(bin, p)
				}
				if b, e := os.ReadFile(p); e == nil {
					r = string(b)
				} else {
					r = nil
				}
			case "ls":
				if ents, e := os.ReadDir(s(0)); e == nil {
					names := []string{}
					for _, x := range ents {
						names = append(names, x.Name())
					}
					sort.Strings(names)
					r = strs(names)
				} else {
					r = nil
				}
			case "loginStart":
				var o *util.Obj
				o, err = jsrt.Await(login.Start(s(0), strp(arg(1))))
				note(o)
				r = o
			case "input":
				r = login.Input(s(0), arg(1))
			case "cancel":
				r = login.Cancel(s(0))
			case "dispose":
				login.Dispose()
			case "openUrl":
				r, err = login.OpenURL(s(0))
			case "wait":
				t0 := time.Now()
				for !hasEvent(s(0)) && time.Since(t0) < 8*time.Second {
					jsrt.Sleep(10 * time.Millisecond)
				}
				if !hasEvent(s(0)) {
					err = errors.New("timeout waiting " + s(0))
				}
			case "events":
				r = events
				events = []any{}
			case "kcService":
				r = []any{ClaudeKeychainService(util.NewObj("CLAUDE_CONFIG_DIR", s(0)), s(0)), ClaudeAccountName(util.NewObj("USER", s(1)))}
			case "isLoginUrl":
				xs := []any{}
				for _, u := range a {
					xs = append(xs, IsLoginURL(u.(string)))
				}
				r = xs
			case "parseLogin":
				xs := []any{}
				for _, u := range a {
					xs = append(xs, ParseLoginOutput(u.(string)))
				}
				r = xs
			case "strip":
				xs := []any{}
				for _, u := range a {
					xs = append(xs, StripTerminal(u.(string)))
				}
				r = xs
			default:
				t.Fatalf("bad op %s", op)
			}
		})
		switch {
		case err != nil:
			out = append(out, util.NewObj("err", jsErr(err)))
		case r == util.Undefined:
			out = append(out, util.NewObj("undef", true))
		default:
			if o, ok := r.(*util.Obj); ok && o == nil {
				r = nil
			}
			out = append(out, util.NewObj("v", r))
		}
	}
	jsrt.Run(func() {
		login.Dispose()
		jsrt.Sleep(100 * time.Millisecond)
		_, _ = jsrt.Await(utils.WhenPrivateWritesIdle())
	})
	txt := strings.ReplaceAll(util.Stringify(out), esc(SB), "<SB>")
	uu := map[string]int{}
	txt = acctUUIDRe.ReplaceAllStringFunc(txt, func(u string) string {
		if _, ok := uu[u]; !ok {
			uu[u] = len(uu) + 1
		}
		return "<U" + itoa(uu[u]) + ">"
	})
	txt = acctKcRe.ReplaceAllString(txt, `credentials-<H>"`)
	txt = acctTmpRe.ReplaceAllString(txt, `${1}<R>"`)
	gotV, _ := util.ParseString(txt)
	got := gotV.([]any)
	steps := sc.Get("steps").([]any)
	for i := range steps {
		w := util.Stringify(want[i])
		g := "<missing>"
		if i < len(got) {
			g = util.Stringify(got[i])
		}
		if g != w {
			t.Errorf("step %d %s:\n got %s\nwant %s", i, trunc(util.Stringify(steps[i]), 200), trunc(g, 1500), trunc(w, 1500))
		}
	}
}

// undefIfNil：Node 返回 undefined 的查找（Go 用 nil *Obj 表示）。
func undefIfNil(o *util.Obj, err error) (any, error) {
	if o == nil {
		return util.Undefined, err
	}
	return o, err
}

func strs(xs []string) []any {
	out := make([]any, 0, len(xs))
	for _, x := range xs {
		out = append(out, x)
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
