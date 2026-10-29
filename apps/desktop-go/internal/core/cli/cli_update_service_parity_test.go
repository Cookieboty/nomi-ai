package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 回放 record-b7s-update.mjs 的场景（场景定义随 golden 一起写出），逐步比对。
var cuEnvBin = map[string]string{"claude": "NOMI_CLAUDE_BIN", "codex": "NOMI_CODEX_BIN", "dsh": "NOMI_DSH_BIN", "grok": "NOMI_GROK_BIN", "gemini": "NOMI_GEMINI_BIN", "cursor": "NOMI_CURSOR_BIN"}
var cuPkgs = map[string]string{"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex", "dsh": "@deepseek-ai/dsh", "grok": "@xai-official/grok", "gemini": "@google/gemini-cli"}

func cuExe(t *testing.T, file, sh, win string) string {
	if runtime.GOOS == "windows" {
		if err := os.WriteFile(file+".cmd", []byte("@echo off\r\n"+win+"\r\n"), 0o666); err != nil {
			t.Fatal(err)
		}
		return file + ".cmd"
	}
	if err := os.WriteFile(file, []byte("#!/bin/sh\n"+sh+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return file
}
func cuVerBin(t *testing.T, file, v string) string {
	return cuExe(t, file, `echo "`+v+`"`, "echo "+v)
}

type cuProbe struct{ p *util.Obj }

func (c cuProbe) s(k string) string    { v, _ := c.p.Get(k).(string); return v }
func (c cuProbe) NodeVersion() string  { return c.s("nodeVersion") }
func (c cuProbe) NpmBin() string       { return c.s("npmBin") }
func (c cuProbe) NpmPrefix() string    { return c.s("npmPrefix") }
func (c cuProbe) CanWrite(string) bool { return c.p.Get("canWrite") == true }

type cuLogger struct{ warns *[]any }

func (cuLogger) Info(string, any)       {}
func (l cuLogger) Warn(m string, _ any) { *l.warns = append(*l.warns, m) }

type cuEvents struct{ t *testing.T }

func (e cuEvents) Publish(ev string, _ any) {
	if ev != "cliUpdate.event" {
		e.t.Errorf("event %s", ev)
	}
}

func cuStrList(v any) []string {
	out := []string{}
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func cuAnyList(ss []string) []any { return cuStrs(ss) }

func TestCliUpdateGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s_update.json", filepath.Join("testdata", "b7s_update.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	gv, err := util.ParseString(string(b))
	if err != nil {
		t.Fatal(err)
	}
	g := gv.(*util.Obj)
	if pl := g.Get("platform").(string); pl != usage.Platform() {
		t.Skipf("golden recorded on %s", pl)
	}
	SB, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "NVM_BIN", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "NPM_CONFIG_PREFIX", "NOMI_USE_MOCK_CLI", "NOMI_NPM_BIN", "NOMI_CLAUDE_BIN", "NOMI_CODEX_BIN", "NOMI_DSH_BIN", "NOMI_GROK_BIN", "NOMI_GEMINI_BIN", "NOMI_CURSOR_BIN"} {
		t.Setenv(k, "")
	}
	steps := 0
	for _, x := range g.Get("scenarios").([]any) {
		sc := x.(*util.Obj)
		name := sc.Get("name").(string)
		want := sc.Get("log").([]any)
		got := runCuScenario(t, sc, SB)
		if len(got) != len(want) {
			t.Errorf("%s: %d steps, want %d", name, len(got), len(want))
			continue
		}
		for i := range want {
			steps++
			w := util.Stringify(want[i])
			gs := b7sScrub(util.Stringify(got[i]), SB)
			if gs != w {
				t.Errorf("%s step %d:\n got %s\nwant %s", name, i, gs, w)
			}
		}
	}
	t.Logf("cli update parity: %d scenarios, %d steps", len(g.Get("scenarios").([]any)), steps)
}

func runCuScenario(t *testing.T, sc *util.Obj, SB string) []any {
	name := sc.Get("name").(string)
	dir := filepath.Join(SB, name)
	home := filepath.Join(dir, "home")
	_ = os.MkdirAll(filepath.Join(dir, "empty"), 0o777)
	_ = os.MkdirAll(home, 0o777)
	os.Setenv("HOME", home)
	os.Setenv("USERPROFILE", home)
	os.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	os.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	os.Setenv("PATH", filepath.Join(dir, "empty"))
	for _, k := range []string{"NVM_BIN", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "NPM_CONFIG_PREFIX", "NOMI_USE_MOCK_CLI", "NOMI_NPM_BIN"} {
		os.Unsetenv(k)
	}
	for _, k := range cuEnvBin {
		os.Unsetenv(k)
	}
	var shL, winL []string
	if npm, ok := sc.Get("npm").(*util.Obj); ok {
		for _, k := range npm.Keys() {
			v, ok := npm.Get(k).(string)
			if !ok || v == "" {
				continue
			}
			shL = append(shL, fmt.Sprintf(`[ "$2" = "%s" ] && { echo '"%s"'; exit 0; }`, cuPkgs[k], v))
			winL = append(winL, fmt.Sprintf(`if "%%2"=="%s" (echo "%s"& exit /b 0)`, cuPkgs[k], v))
		}
	}
	// 与 Node 端 lines.join('\n') + '\nexit 1' 同形（空列表时开头留一个换行）
	shPre, winPre := "", ""
	if sc.Get("slowNpm") == true {
		shPre, winPre = "/bin/sleep 1\n", `"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul`+"\r\n"
	}
	npmLog := filepath.Join(dir, "npm.log")
	shPre = "echo x >> \"" + npmLog + "\"\n" + shPre
	// 并发的 cmd 追加会因共享冲突丢行（Node/Go 同样），失败即重试
	winPre = ":nomilog\r\n(echo x>>\"" + npmLog + "\") 2>nul || goto nomilog\r\n" + winPre
	npmBin := cuExe(t, filepath.Join(dir, "fakenpm"), shPre+strings.Join(shL, "\n")+"\nexit 1", winPre+strings.Join(winL, "\r\n")+"\r\nexit /b 1")
	os.Setenv("NOMI_NPM_BIN", npmBin)
	if bins, ok := sc.Get("bins").(*util.Obj); ok {
		for _, kind := range bins.Keys() {
			a := bins.Get(kind).([]any)
			sub := "bin"
			switch a[0] {
			case "native":
				sub = "versions"
			case "npm":
				sub = "node_modules"
			}
			d := filepath.Join(home, sub, kind)
			_ = os.MkdirAll(d, 0o777)
			os.Setenv(cuEnvBin[kind], cuVerBin(t, filepath.Join(d, kind), a[1].(string)))
		}
	}
	cacheDir := filepath.Join(dir, "cache")
	_ = os.MkdirAll(cacheDir, 0o777)
	cacheFile := filepath.Join(cacheDir, "cache.json")
	if c, ok := sc.Get("cache").(*util.Obj); ok {
		c = c.Clone()
		if c.Get("checkedAt") == "now" {
			c.Set("checkedAt", float64(time.Now().UnixMilli()))
		}
		_ = os.WriteFile(cacheFile, []byte(util.Stringify(c)), 0o666)
	}
	if sc.Has("cacheRaw") {
		_ = os.WriteFile(cacheFile, []byte(sc.Get("cacheRaw").(string)), 0o666)
	}
	ResetCliBinCache()

	P := util.NewObj("nodeVersion", "24.1.0", "npmBin", "/usr/bin/npm", "npmPrefix", filepath.Join(dir, "prefix"), "canWrite", true)
	if pr, ok := sc.Get("probe").(*util.Obj); ok {
		for _, k := range pr.Keys() {
			P.Set(k, pr.Get(k))
		}
	}
	var mu sync.Mutex
	runnerCalls := []any{}
	holds := []func(){}
	ri := 0
	runnerSpec, _ := sc.Get("runner").([]any)
	runner := func(argv []string, onLine func(string), _ int) *jsrt.Promise[CliRunOutput] {
		r := util.NewObj("code", float64(0), "output", "")
		if ri < len(runnerSpec) {
			r = runnerSpec[ri].(*util.Obj)
		}
		ri++
		runnerCalls = append(runnerCalls, cuAnyList(argv))
		finish := func() CliRunOutput {
			if ls, ok := r.Get("lines").([]any); ok {
				for _, l := range ls {
					onLine(l.(string))
				}
			}
			if n, ok := r.Get("many").(float64); ok {
				for i := 0; i < int(n); i++ {
					onLine(fmt.Sprintf("line %d", i))
				}
			}
			if in, ok := r.Get("install").([]any); ok {
				prefix := P.Get("npmPrefix").(string)
				for i, a := range argv {
					if a == "--prefix" {
						prefix = argv[len(argv)-1]
						_ = i
					}
				}
				binDir := NpmPrefixBinDir(prefix, usage.Platform())
				_ = os.MkdirAll(binDir, 0o777)
				cuVerBin(t, filepath.Join(binDir, in[0].(string)), in[1].(string))
			}
			if bu, ok := r.Get("bump").([]any); ok {
				cuVerBin(t, strings.TrimSuffix(os.Getenv(cuEnvBin[bu[0].(string)]), ".cmd"), bu[1].(string))
			}
			out := CliRunOutput{Output: r.Get("output").(string)}
			if c, ok := r.Get("code").(float64); ok {
				ci := int(c)
				out.Code = &ci
			}
			return out
		}
		if r.Get("hold") != true {
			return jsrt.Async(func() (CliRunOutput, error) { return finish(), nil })
		}
		pr := jsrt.NewPromise[CliRunOutput]()
		mu.Lock()
		holds = append(holds, func() { pr.Resolve(finish()) })
		mu.Unlock()
		return pr
	}
	events := []*util.Obj{}
	warns := []any{}
	drainCalls := []any{}
	updated := []any{}
	opts := CliUpdateOptions{
		Root: cacheDir, Logger: cuLogger{&warns}, Probe: cuProbe{P}, Runner: runner,
		Events: cuEvents{t}, Emit: func(e *util.Obj) { events = append(events, e) }, Platform: usage.Platform(),
	}
	if pl, ok := sc.Get("platform").(string); ok {
		opts.Platform = pl
	}
	if sc.Has("drain") {
		dv := sc.Get("drain")
		opts.Drain = func(k string) *jsrt.Promise[int] {
			drainCalls = append(drainCalls, k)
			if dv == "reject" {
				return jsrt.Rejected[int](errors.New("x"))
			}
			return jsrt.Resolved(int(dv.(float64)))
		}
	}
	if ou := sc.Get("onUpdated"); ou != nil && ou != false {
		opts.OnUpdated = func(k, v string) {
			updated = append(updated, []any{k, nz(v)})
			if ou == "throw" {
				panic(errors.New("hook"))
			}
		}
	}
	var s *CliUpdateService
	var nerr error
	jsrt.Run(func() { s, nerr = NewCliUpdateService(opts) })
	if nerr != nil {
		t.Fatal(nerr)
	}
	runs := map[string]*jsrt.Promise[*util.Obj]{}
	job := func(j *util.Obj) any {
		if j == nil {
			return nil
		}
		j = j.Clone()
		j.Set("startedAt", "number")
		if j.Has("finishedAt") {
			j.Set("finishedAt", "number")
		}
		return j
	}
	str := func(v any) string { s, _ := v.(string); return s }
	log := []any{}
	for _, stx := range sc.Get("steps").([]any) {
		st := stx.([]any)
		op := st[0].(string)
		arg := func(i int) any {
			if i < len(st) {
				return st[i]
			}
			return nil
		}
		var v any
		switch op {
		case "recipes", "recipesNoBin":
			var rs []UpdateRecipe
			if op == "recipes" {
				rs = UpdateRecipes(str(arg(1)), "/x/"+str(arg(1)), str(arg(2)), "global")
			} else {
				rs = UpdateRecipes(str(arg(1)), "", "unknown", str(arg(2)))
			}
			out := []any{}
			for _, r := range rs {
				out = append(out, util.NewObj("kind", r.Kind, "via", r.Via, "argv", cuAnyList(r.Argv)))
			}
			v = out
		case "allow":
			v = IsAllowedUpdateArgv(cuStrList(arg(1)))
		case "allowUserPrefix":
			v = IsAllowedUpdateArgv([]string{"npm", "install", "-g", "@deepseek-ai/dsh@latest", "--prefix", UserPrefix()})
		case "allowEnvNpm":
			a := cuStrList(arg(1))
			v = []any{IsAllowedUpdateArgv(append([]string{npmBin}, a...)), IsAllowedUpdateArgv(append([]string{"/other/npmx"}, a...))}
		case "cmdline":
			v = CommandLine(cuStrList(arg(1)))
		case "toUpdatable":
			v = ToUpdatable(arg(1))
		case "toScope":
			v = ToScope(arg(1))
		case "updatable":
			v = IsUpdatable(str(arg(1)))
		case "preview":
			var pr *jsrt.Promise[*util.Obj]
			jsrt.Run(func() { pr = s.PreviewUpdate(str(arg(1)), str(arg(2))) })
			r, _ := jsrt.Block(pr)
			v = r
		case "inspect":
			var pr *jsrt.Promise[[]*util.Obj]
			jsrt.Run(func() { pr = s.Inspect(arg(1) == true) })
			r, _ := jsrt.Block(pr)
			out := []any{}
			for _, o := range r {
				out = append(out, o)
			}
			v = out
		case "run":
			jsrt.Run(func() { runs[str(arg(1))] = s.Run(str(arg(2)), str(arg(3))) })
		case "await":
			r, _ := jsrt.Block(runs[str(arg(1))])
			v = r
		case "inspectTwice":
			var a, b2 *jsrt.Promise[[]*util.Obj]
			jsrt.Run(func() { a = s.Inspect(true); b2 = s.Inspect(true) })
			x, _ := jsrt.Block(a)
			y, _ := jsrt.Block(b2)
			xs, ys := []any{}, []any{}
			for _, o := range x {
				xs = append(xs, o)
			}
			for _, o := range y {
				ys = append(ys, o)
			}
			v = util.Stringify(xs) == util.Stringify(ys)
		case "npmCalls":
			n := 0
			if b, err := os.ReadFile(npmLog); err == nil {
				for _, l := range strings.Split(string(b), "\n") {
					if util.JSTrim(l) != "" {
						n++
					}
				}
			}
			_ = os.Remove(npmLog)
			v = float64(n)
		case "same":
			v = runs[str(arg(1))] == runs[str(arg(2))]
		case "release":
			mu.Lock()
			h := holds[int(arg(1).(float64))]
			mu.Unlock()
			jsrt.Run(h)
			time.Sleep(50 * time.Millisecond)
		case "idle":
			ms := 400.0
			if n, ok := arg(1).(float64); ok {
				ms = n
			}
			time.Sleep(time.Duration(ms) * time.Millisecond)
		case "job":
			jsrt.Run(func() { v = job(s.Job(str(arg(1)))) })
		case "jobLines":
			jsrt.Run(func() {
				ls := s.Job(str(arg(1))).Get("lines").([]any)
				v = []any{float64(len(ls)), ls[0], ls[len(ls)-1]}
			})
		case "dismiss":
			jsrt.Run(func() { v = s.DismissJob(str(arg(1))) })
		case "busy":
			jsrt.Run(func() { v = cuAnyList(s.BusyKinds()) })
		case "events":
			jsrt.Run(func() {
				by := util.NewObj()
				for _, e := range events {
					k := e.Get("kind").(string)
					l, _ := by.Get(k).([]any)
					by.Set(k, append(l, e))
				}
				events = nil
				v = by
			})
		case "runnerCalls":
			jsrt.Run(func() { v = runnerCalls; runnerCalls = []any{} })
		case "drainCalls":
			v = drainCalls
		case "updatedCalls":
			v = updated
		case "warns":
			jsrt.Run(func() { v = warns; warns = []any{} })
		case "cacheFile":
			b, err := os.ReadFile(cacheFile)
			if err != nil {
				v = "unreadable"
				break
			}
			c, err := util.ParseString(string(b))
			if err != nil {
				v = "unreadable"
				break
			}
			if o, ok := c.(*util.Obj); ok {
				o = o.Clone()
				if n, ok := o.Get("checkedAt").(float64); ok && n > 1e12 {
					o.Set("checkedAt", "recent")
				}
				c = o
			}
			v = c
		default:
			t.Fatalf("op %s", op)
		}
		log = append(log, []any{op, v})
	}
	return log
}
