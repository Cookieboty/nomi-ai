package harness

// b7t：标签操作与 session.json / tabs.json / tabs/*.json 落盘、加载的 Node golden 回放
// （scripts/parity/record-b7-tabs.mjs，场景表 b7-tabs-scenarios.json）。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// tabsNorm：同录制器 norm——去掉 bins（机器相关 CLI 路径），lastActiveAt 也按时间键处理。
func tabsNorm(v any, tmp string) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = tabsNorm(e, tmp)
		}
		return out
	case []*util.Obj:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = tabsNorm(e, tmp)
		}
		return out
	case []string:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = e
		}
		return tabsNorm(out, tmp)
	case *util.Obj:
		if x == nil {
			return nil
		}
		o := util.NewObj()
		for _, k := range x.Keys() {
			if k == "bins" {
				continue
			}
			e := x.Get(k)
			if _, u := e.(util.JSUndefined); u {
				continue
			}
			if k == "lastActiveAt" {
				switch e.(type) {
				case float64, int:
					o.Set(k, "<N>")
					continue
				}
			}
			o.Set(k, tabsNorm(e, tmp))
		}
		return orchNorm(o, tmp)
	}
	return orchNorm(v, tmp)
}

func walkHarness(dir string) []any {
	files := []any{}
	var rec func(d, rel string)
	rec = func(d, rel string) {
		ents, _ := os.ReadDir(d)
		for _, e := range ents {
			p := filepath.Join(d, e.Name())
			r := e.Name()
			if rel != "" {
				r = rel + "/" + e.Name()
			}
			if e.IsDir() {
				rec(p, r)
				continue
			}
			b, _ := os.ReadFile(p)
			v, err := util.Parse(b)
			if err != nil {
				v = string(b)
			}
			files = append(files, []any{r, v})
		}
	}
	rec(dir, "")
	return files
}

var tabRefRe = regexp.MustCompile(`^\$\d+$`)

// tryCall：同步方法里的 throw（JSThrow panic）→ {err}。
func tryCall(fn func() any) (r *util.Obj) {
	defer func() {
		if x := recover(); x != nil {
			e, ok := x.(jsrt.JSThrow)
			if !ok {
				panic(x)
			}
			r = util.NewObj("err", e.Message)
		}
	}()
	return util.NewObj("ok", fn())
}

func runTabsCase(t *testing.T, c *util.Obj) *util.Obj {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	work := filepath.Join(tmp, "work")
	_ = os.MkdirAll(work, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	hroot := filepath.Join(tmp, "harness")
	t.Setenv("NOMI_USE_MOCK_CLI", "1")
	var ids []string
	var sub func(v any) any
	sub = func(v any) any {
		switch x := v.(type) {
		case string:
			if tabRefRe.MatchString(x) {
				n := 0
				for _, ch := range x[1:] {
					n = n*10 + int(ch-'0')
				}
				if n < len(ids) {
					return ids[n]
				}
				return x
			}
			return strings.ReplaceAll(strings.ReplaceAll(x, "$W", work), "$T", tmp)
		case []any:
			out := make([]any, len(x))
			for i, e := range x {
				out[i] = sub(e)
			}
			return out
		case *util.Obj:
			o := util.NewObj()
			for _, k := range x.Keys() {
				o.Set(k, sub(x.Get(k)))
			}
			return o
		}
		return v
	}
	if f := util.AsObj(c.Get("files")); f != nil {
		for _, rel := range f.Keys() {
			p := filepath.Join(hroot, filepath.FromSlash(rel))
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			body := f.Get(rel)
			s, ok := body.(string)
			if !ok {
				s = util.Stringify(sub(body))
			}
			_ = os.WriteFile(p, []byte(s), 0o644)
		}
	}
	idle := 0.0
	mk := func() *Orchestrator {
		return New(Deps{Root: hroot, Home: tmp, DefaultCwd: filepath.Join(tmp, "docs", "nomi"),
			LegacyDefaultCwd: filepath.Join(tmp, "docs"), Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
	}
	opt := func(o *util.Obj, k string) any {
		if o == nil || !o.Has(k) {
			return util.Undefined
		}
		return o.Get(k)
	}
	var o *Orchestrator
	call := func(name string, a []any) any {
		s := func(i int) string { v, _ := a[i].(string); return v }
		switch name {
		case "createTab":
			opts := util.AsObj(a[0])
			tb := o.CreateTab(opts)
			ids = append(ids, str(tb, "id"))
			return tb
		case "listTabs":
			return o.ListTabs()
		case "renameTab":
			return o.RenameTab(s(0), a[1])
		case "setActiveTab":
			return o.SetActiveTab(s(0))
		case "closeTab":
			return o.CloseTab(s(0))
		case "setTabBackend":
			return o.SetTabBackend(s(0), a[1])
		case "setTabCwd":
			return o.SetTabCwd(s(0), s(1), opt(util.AsObj(a[2]), "carry") == true)
		case "setCwd":
			return o.SetCwd(s(0), opt(util.AsObj(a[1]), "carry") == true)
		case "recentCwds":
			return o.RecentCwds()
		case "setTabPermissionMode":
			return o.SetTabPermissionMode(s(0), a[1], PermOpts{})
		case "setPermissionDefaults":
			x := util.AsObj(a[0])
			return o.SetPermissionDefaults(opt(x, "defaultPermissionMode"), opt(x, "codexNetwork"), opt(x, "autoApprove"))
		case "setTabReasoningEffort":
			return o.SetTabReasoningEffort(s(0), a[1])
		case "seedTabMessages":
			l, _ := a[1].([]any)
			return o.SeedTabMessages(s(0), l)
		case "tabMessages":
			return o.TabMessages(s(0))
		case "clearTabCarry":
			return o.ClearTabCarry(s(0))
		case "rewindTab":
			return o.RewindTab(s(0), s(1))
		}
		t.Fatalf("unknown op %s", name)
		return nil
	}
	settle := func(v any) *util.Obj {
		if p, ok := v.(*jsrt.Promise[[]*util.Obj]); ok {
			r, err := jsrt.Await(p)
			if err != nil {
				return util.NewObj("err", err.Error())
			}
			return util.NewObj("ok", r)
		}
		return util.NewObj("ok", v)
	}
	// 整个场景在一个 async 帧里跑：同 Node 录制器，相邻操作之间只让出微任务
	res, berr := jsrt.Block(jsrt.Async(func() (*util.Obj, error) {
		o = mk()
		snap := func() *util.Obj { return util.NewObj("tabs", o.ListTabs(), "state", o.State()) }
		steps := []any{}
		var pending []*jsrt.Promise[[]*util.Obj]
		for _, opv := range c.Get("ops").([]any) {
			op := opv.([]any)
			name := op[0].(string)
			switch name {
			case "reload":
				o.FlushPersist()
				o.Dispose()
				o = mk()
				steps = append(steps, []any{"reload", snap()})
				continue
			case "await":
				rs := []any{}
				for _, p := range pending {
					rs = append(rs, settle(p))
				}
				pending = nil
				steps = append(steps, []any{"await", rs})
				continue
			}
			isAsync := name == "async"
			args := op[1:]
			if isAsync {
				name, args = op[1].(string), op[2:]
			}
			a := sub(args).([]any)
			r := tryCall(func() any { return call(name, a) })
			if isAsync {
				if r.Has("err") {
					p := jsrt.NewPromise[[]*util.Obj]()
					p.Reject(jsrt.JSThrow{Message: r.Get("err").(string)})
					pending = append(pending, p)
				} else {
					pending = append(pending, r.Get("ok").(*jsrt.Promise[[]*util.Obj]))
				}
				steps = append(steps, []any{name, "started"})
				continue
			}
			if r.Has("ok") {
				r = settle(r.Get("ok"))
			}
			steps = append(steps, []any{name, r})
		}
		o.FlushPersist()
		final := snap()
		o.Dispose()
		out := util.NewObj("name", c.Get("name"), "steps", steps, "final", final)
		return out, nil
	}))
	if berr != nil {
		t.Fatal(berr)
	}
	out := res
	out.Set("disk", walkHarness(hroot))
	// 经 JSON 往返：undefined 值的键同 Node norm 一样被丢弃
	rt, _ := util.Parse([]byte(util.Stringify(out)))
	return util.AsObj(tabsNorm(rt, tmp))
}

func loadTabsJSON(t *testing.T, p string) []any {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return util.AsObj(v).Get("cases").([]any)
}

func TestOrchestratorTabsGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7_orch_tabs.json", filepath.Join("testdata", "b7_orch_tabs.json"))
	golden := loadTabsJSON(t, p)
	scen := loadTabsJSON(t, filepath.Join(repoRoot(t), "scripts/parity/b7-tabs-scenarios.json"))
	if len(golden) != len(scen) {
		t.Fatalf("golden %d cases vs scenarios %d — re-record", len(golden), len(scen))
	}
	orchRoot = repoRoot(t)
	t.Chdir(orchRoot)
	t.Setenv("NOMI_LOCALE", "en")
	for i, sc := range scen {
		c := util.AsObj(sc)
		want := util.Stringify(golden[i])
		t.Run(c.Get("name").(string), func(t *testing.T) {
			got := util.Stringify(runTabsCase(t, c))
			if got != want {
				t.Fatalf("mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

// 变异检查：改动磁盘内容 / 标签列表 / 某一步结果，逐字比对都必须失败。
func TestOrchestratorTabsGoldenMutation(t *testing.T) {
	golden := loadTabsJSON(t, filepath.Join("testdata", "b7_orch_tabs.json"))
	if len(golden) < 20 {
		t.Fatalf("expected ≥20 recorded cases, got %d", len(golden))
	}
	for i, g := range golden {
		orig := util.Stringify(g)
		muts := []func(m *util.Obj){
			func(m *util.Obj) { m.Set("disk", append(m.Get("disk").([]any), []any{"x.json", 1.0})) },
			func(m *util.Obj) {
				tabs := util.AsObj(util.AsObj(m.Get("final")).Get("tabs"))
				tabs.Set("activeTabId", "MUTATED")
			},
			func(m *util.Obj) {
				st := m.Get("steps").([]any)
				st[0].([]any)[1] = "MUTATED"
			},
		}
		for j, mut := range muts {
			m := util.AsObj(tabsNorm(g, "\x00"))
			mut(m)
			if util.Stringify(m) == orig {
				t.Fatalf("case %d mutation %d not detected", i, j)
			}
		}
		if util.Stringify(tabsNorm(g, "\x00")) != orig {
			t.Fatalf("case %d: normaliser not idempotent on golden", i)
		}
	}
}
