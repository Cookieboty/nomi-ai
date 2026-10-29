// Package contract mirrors packages/cli-sdk/src/testing/index.ts（checkPlugin 插件契约检查）。
package contract

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var secretShapes = []*regexp.Regexp{
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`(?i)\bBearer[\t\n\v\f\r \x{a0}\x{feff}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]+[^\t\n\v\f\r \x{a0}\x{feff}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}]{6,}`),
	regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{20,}`),
	regexp.MustCompile(`\bnomi-(?:gw|tab)-[A-Za-z0-9_-]{6,}`),
	regexp.MustCompile(`\b(xai|gsk|ghp|gho|github_pat|glpat|hf)_[A-Za-z0-9_]{12,}`),
}

// HistoryFixture = HistoryFixture（Expect 字段 nil = 未给）。
type HistoryFixture struct {
	Name, Text, Path string
	Messages         *int
	Title            *string
	Error            bool
}

type Options struct {
	// Host：在默认宿主上打补丁（= Partial<CliMainHost> 展开覆盖）
	Host            func(h *clisdk.CliMainHost)
	HistoryFixtures []HistoryFixture
	Extend          func(*clisdk.CliMainImpl) *clisdk.CliMainImpl
}

func stable(v any) string { return util.Stringify(v) }

func strsAny(l []string) []any {
	out := []any{}
	for _, s := range l {
		out = append(out, s)
	}
	return out
}

func secretsIn(vals []string) []string {
	out := []string{}
	for _, v := range vals {
		for _, re := range secretShapes {
			if re.MatchString(v) {
				out = append(out, v)
				break
			}
		}
	}
	return out
}

type nopLogger struct{}

func (nopLogger) Info(string, any) {}
func (nopLogger) Warn(string, any) {}

// CheckPlugin 返回问题列表（空 = 通过）；error = Node 的 checkPlugin reject（未捕获异常）。
func CheckPlugin(p clisdk.CliPlugin, o Options) (problems []string, err error) {
	defer func() {
		if r := recover(); r != nil {
			problems, err = nil, fmt.Errorf("%v", r)
		}
	}()
	return checkPlugin(p, o)
}

func checkPlugin(p clisdk.CliPlugin, o Options) ([]string, error) {
	problems := []string{}
	m := p.Manifest
	var raw any = m // nil *Obj = null（避免 typed-nil 被当成对象）
	if m == nil {
		raw = nil
	}
	for _, e := range clisdk.ValidateManifest(raw) {
		problems = append(problems, "manifest: "+e)
	}
	if len(problems) > 0 {
		return problems, nil
	}
	if p.Main == nil {
		return []string{"main: built-in plugins must provide a main implementation"}, nil
	}
	host := clisdk.CliMainHost{Logger: nopLogger{}, DataDir: "/tmp/nomi-contract", Home: "/home/tester", Env: clisdk.Env{}, Platform: "linux"}
	if o.Host != nil {
		o.Host(&host)
	}
	impl, err := p.Main(host)
	if err != nil {
		return []string{"main: factory threw " + err.Error()}, nil
	}
	if o.Extend != nil {
		impl = o.Extend(impl)
	}
	caps, _ := m.Get("capabilities").(*util.Obj)
	capb := func(k string) bool { b, _ := caps.Get(k).(bool); return b }
	need := func(cond, ok bool, what string) {
		if cond && !ok {
			problems = append(problems, fmt.Sprintf("capability %s is declared but not implemented", what))
		}
	}
	need(capb("resume"), impl.History != nil && impl.History.Roots != nil && impl.History.Resume != nil, "resume (history.roots/resume)")
	need(capb("officialAccount"), impl.Accounts != nil, "officialAccount (accounts)")
	need(capb("terminalCommand"), impl.Terminal != nil, "terminalCommand (terminal)")
	need(capb("progressMonitor"), impl.Progress != nil, "progressMonitor (progress)")
	need(capb("usageQuota"), impl.Usage != nil, "usageQuota (usage)")

	if m.Get("modelSwitch") == "gateway" {
		ph := impl.Launch.PlaceholderModel
		if ph == "" {
			problems = append(problems, "modelSwitch 'gateway' requires launch.placeholderModel")
		}
		if cs, ok := m.Get("clientSpec").(*util.Obj); ok && cs.Has("placeholderModel") {
			specPh := util.JSString(cs.Get("placeholderModel"))
			if ph != "" && specPh != ph {
				problems = append(problems, fmt.Sprintf("launch.placeholderModel (%s) differs from clientSpec (%s)", ph, specPh))
			}
		}
	}

	declared := []string{}
	var specs []any
	if l, ok := caps.Get("permissionModes").([]any); ok {
		specs = l
		for _, x := range l {
			declared = append(declared, util.JSString(x.(*util.Obj).Get("mode")))
		}
	}
	launchOf := func(mode string) *util.Obj {
		a, e := impl.Permissions.Launch(mode, nil)
		return util.NewObj("args", strsAny(a), "env", e)
	}
	if len(declared) > 0 {
		if impl.Permissions == nil {
			problems = append(problems, "permissionModes declared but permissions not implemented")
		} else {
			sup := append([]string{}, impl.Permissions.Supported...)
			sort.Strings(sup)
			dec := append([]string{}, declared...)
			sort.Strings(dec)
			if stable(strsAny(sup)) != stable(strsAny(dec)) {
				problems = append(problems, fmt.Sprintf("permissions.supported (%s) differs from manifest (%s)", strings.Join(sup, ","), strings.Join(dec, ",")))
			}
			for i, mode := range declared {
				a, b := launchOf(mode), launchOf(mode)
				if stable(a) != stable(b) {
					problems = append(problems, fmt.Sprintf("permissions.launch(%s) is not deterministic", mode))
				}
				spec := specs[i].(*util.Obj)
				for j := 0; j < i; j++ { // find() 取第一个同名
					if util.JSString(specs[j].(*util.Obj).Get("mode")) == mode {
						spec = specs[j].(*util.Obj)
						break
					}
				}
				if sa := spec.Get("args"); util.Truthy(sa) && stable(sa) != stable(a.Get("args")) {
					problems = append(problems, fmt.Sprintf("permissions.launch(%s).args differ from manifest", mode))
				}
				if mid := spec.Get("modeId"); util.Truthy(mid) && impl.Permissions.ModeID != nil && any(impl.Permissions.ModeID(mode)) != mid {
					problems = append(problems, fmt.Sprintf("permissions.modeId(%s) differs from manifest", mode))
				}
			}
		}
	}

	for _, acct := range []*string{nil, ptr("/acct/one")} {
		mode := "plan"
		if len(declared) > 0 {
			mode = declared[0]
		}
		ctx := clisdk.LaunchContext{Cwd: "/work", PermissionMode: mode, Model: ptr("model-x"), AccountDir: acct, RunDir: "/tmp/nomi-run"}
		a, b := impl.Launch.Official(ctx), impl.Launch.Official(ctx)
		lo := func(l clisdk.AgentLaunch) string {
			return stable(launchObj(l))
		}
		accStr := "null"
		if acct != nil {
			accStr = *acct
		}
		if lo(a) != lo(b) {
			problems = append(problems, "launch.official is not deterministic (accountDir="+accStr+")")
		}
		vals := append([]string{}, a.Args...)
		if a.Env != nil {
			for _, k := range a.Env.Keys() {
				vals = append(vals, util.JSString(a.Env.Get(k)))
			}
		}
		if leaked := secretsIn(vals); len(leaked) > 0 {
			problems = append(problems, "launch.official contains secret-looking values: "+strings.Join(leaked, ","))
		}
		if acct != nil && impl.Accounts != nil {
			if v, _ := a.Env.Get(impl.Accounts.HomeEnv).(string); v != *acct {
				problems = append(problems, "launch.official does not point "+impl.Accounts.HomeEnv+" at the account dir")
			}
		}
	}

	if acc := impl.Accounts; acc != nil {
		found := false
		for _, s := range acc.Strip {
			found = found || s == acc.HomeEnv
		}
		if !found {
			problems = append(problems, "accounts.strip must include "+acc.HomeEnv+" (S3)")
		}
		for _, s := range acc.Shared {
			bad := strings.HasPrefix(s.Name, "/")
			for _, seg := range regexp.MustCompile(`[\\/]`).Split(s.Name, -1) {
				bad = bad || seg == ".."
			}
			if bad {
				problems = append(problems, "accounts.shared entry "+s.Name+" must be a relative path inside the home")
			}
		}
		if len(acc.LoginArgs) == 0 {
			problems = append(problems, "accounts.loginArgs is empty")
		}
	}

	if len(o.HistoryFixtures) > 0 && (impl.History == nil || impl.History.Parse == nil) {
		problems = append(problems, "history fixtures given but history.parse is not implemented")
	} else {
		for _, f := range o.HistoryFixtures {
			path := f.Path
			if path == "" {
				path = "/fixtures/" + f.Name
			}
			r, perr := safeParse(impl.History.Parse, f.Text, clisdk.HistoryFileRef{Path: path, Size: float64(len(utf16(f.Text)))})
			if perr != "" {
				problems = append(problems, "history fixture "+f.Name+": parse threw "+perr)
				continue
			}
			if f.Error {
				if !r.Has("error") {
					problems = append(problems, "history fixture "+f.Name+": expected an error")
				}
				continue
			}
			if r.Has("error") {
				problems = append(problems, "history fixture "+f.Name+": "+util.JSString(r.Get("error")))
				continue
			}
			// countMessages：'meta' in p ? (p.messages?.length ?? 0) : undefined
			n := "undefined"
			if r.Has("meta") {
				c := 0
				switch l := r.Get("messages").(type) {
				case []any:
					c = len(l)
				case string:
					c = len(utf16(l))
				}
				n = fmt.Sprint(c)
			}
			if f.Messages != nil && n != fmt.Sprint(*f.Messages) {
				problems = append(problems, fmt.Sprintf("history fixture %s: %s messages, expected %d", f.Name, n, *f.Messages))
			}
			if f.Title != nil {
				mv, hasMeta := r.Lookup("meta")
				meta, _ := mv.(*util.Obj)
				if !hasMeta || mv == nil || mv == util.Undefined {
					return nil, fmt.Errorf("Cannot read properties of %s (reading 'title')", map[bool]string{true: "null", false: "undefined"}[hasMeta && mv == nil])
				}
				t, has := any(nil), false
				if meta != nil {
					t, has = meta.Lookup("title")
				}
				if ts, ok := t.(string); !has || !ok || ts != *f.Title {
					ws := "undefined"
					if has && t != util.Undefined {
						ws = stable(t)
					}
					problems = append(problems, fmt.Sprintf("history fixture %s: title %s, expected %s", f.Name, ws, stable(*f.Title)))
				}
			}
		}
	}
	return problems, nil
}

func safeParse(parse func(string, clisdk.HistoryFileRef) *util.Obj, text string, f clisdk.HistoryFileRef) (r *util.Obj, msg string) {
	defer func() {
		if x := recover(); x != nil {
			if e, ok := x.(error); ok {
				msg = e.Error()
			} else {
				msg = fmt.Sprint(x)
			}
		}
	}()
	return parse(text, f), ""
}

// launchObj：AgentLaunch 的 JSON 形状（stable 比较用；未给的字段不出现）
func launchObj(l clisdk.AgentLaunch) *util.Obj {
	o := util.NewObj("env", l.Env, "args", strsAny(l.Args))
	if l.Strip != nil {
		o.Set("strip", strsAny(l.Strip))
	}
	if l.Files != nil {
		fs := []any{}
		for _, f := range l.Files {
			fo := util.NewObj("path", f.Path, "content", f.Content)
			if f.Mode != nil {
				fo.Set("mode", float64(*f.Mode))
			}
			fs = append(fs, fo)
		}
		o.Set("files", fs)
	}
	if h := l.PrivateHome; h != nil {
		o.Set("privateHome", util.NewObj("envVar", h.EnvVar, "shared", h.Shared, "keepPrivate", strsAny(h.KeepPrivate)))
	}
	return o
}

func ptr(s string) *string { return &s }

func utf16(s string) []uint16 {
	out := []uint16{}
	for _, r := range s {
		if r >= 0x10000 {
			out = append(out, 0, 0)
		} else {
			out = append(out, 0)
		}
	}
	return out
}
