package cli

// 批次 7 item 2 golden：scripts/parity/record-b7-cli.mjs 在每个平台录制 Node 行为（CI 中 NOMI_LIVE_GOLDENS），
// Go 在同样布局的沙箱里重放每个用例并逐条比对 JSON。Windows 上覆盖 .cmd/.exe 解析（PATHEXT / 盘上大小写）、
// cmd.exe 垫片（verbatim 命令行）、npm .cmd 解包、taskkill 进程树、cliSearchDirs / withCliPath 的 Windows 分支。

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"

	"database/sql"

	_ "modernc.org/sqlite"
)

type cliGolden struct {
	platform, delimiter string
	fixtures            []*util.Obj
	cases               []*util.Obj
}

func loadCliGolden(t *testing.T) cliGolden {
	p, _ := paritytest.Golden(t, "cli.json", filepath.Join("testdata", "cli.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		t.Fatal(err)
	}
	o := v.(*util.Obj)
	g := cliGolden{platform: o.Get("platform").(string), delimiter: o.Get("delimiter").(string)}
	for _, f := range o.Get("fixtures").([]any) {
		g.fixtures = append(g.fixtures, f.(*util.Obj))
	}
	for _, c := range o.Get("cases").([]any) {
		g.cases = append(g.cases, c.(*util.Obj))
	}
	return g
}

// 把 Go 结果中的沙箱 / node 路径替换为占位符（与录制器 unsub 一致）
func unsub(v any, sb, node string) any {
	switch x := v.(type) {
	case string:
		return strings.ReplaceAll(strings.ReplaceAll(x, sb, "<SB>"), node, "<NODE>")
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = unsub(e, sb, node)
		}
		return out
	case []string:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = unsub(e, sb, node)
		}
		return out
	case []*util.Obj:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = unsub(e, sb, node)
		}
		return out
	case *util.Obj:
		if x == nil {
			return nil
		}
		o := util.NewObj()
		for _, k := range x.Keys() {
			o.Set(k, unsub(x.Get(k), sb, node))
		}
		return o
	}
	return v
}

type outcome struct {
	v     any
	undef bool
	err   string
	kind  string
}

func val(v any) outcome { return outcome{v: v} }

func strOrNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func floats(fs []float64) any {
	if fs == nil {
		return nil
	}
	out := make([]any, len(fs))
	for i, f := range fs {
		out[i] = f
	}
	return out
}

func objFromMap(kv ...any) *util.Obj { return util.NewObj(kv...) }

func envObj(kv ...string) *util.Obj {
	o := util.NewObj()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i], kv[i+1])
	}
	return o
}

type fakeSecrets struct{ mode string }

func (f fakeSecrets) Available() bool {
	if f.mode == "throwAvail" {
		panic("x")
	}
	return f.mode != "off"
}
func (f fakeSecrets) Decrypt(b []byte) (string, error) {
	if f.mode == "throw" {
		return "", errors.New("bad")
	}
	return fmt.Sprintf("dec(%x)", b), nil
}

type fakeTreeChild struct {
	pid int
	log []any
}

func (c *fakeTreeChild) PID() int { return c.pid }
func (c *fakeTreeChild) Kill(s string) bool {
	c.log = append(c.log, s)
	if c.pid == 99 {
		panic("gone")
	}
	return true
}

func findNode(t *testing.T) string {
	n, err := exec.LookPath("node")
	if err != nil {
		paritytest.SkipOrFail(t, "node not on PATH")
	}
	if r, err := filepath.EvalSymlinks(n); err == nil {
		n = r
	}
	return n
}

func TestCliLeavesGolden(t *testing.T) {
	g := loadCliGolden(t)
	if g.platform != usage.Platform() {
		t.Skipf("golden recorded on %s (run with NOMI_LIVE_GOLDENS on this platform)", g.platform)
	}
	node := findNode(t)
	sb, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if abs, err := filepath.Abs(sb); err == nil {
		sb = abs
	}
	p := func(rel string) string { return filepath.Join(append([]string{sb}, strings.Split(rel, "/")...)...) }
	for _, f := range g.fixtures {
		abs := p(f.Get("p").(string))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o644)
		if m, ok := f.Get("mode").(float64); ok {
			mode = os.FileMode(int(m))
		}
		if err := os.WriteFile(abs, []byte(f.Get("c").(string)), mode); err != nil {
			t.Fatal(err)
		}
	}
	isWin := runtime.GOOS == "windows"

	got := map[string]outcome{}
	add := func(name string, o outcome) { got[name] = o }

	// semver
	vers := []string{"1.0.0", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0-rc.2.1", "1.0.0-alpha", "1.0.0-1", "1.0.0-a.b",
		"2.0.0", "v1.2.3", "x", "0.2.0-rc.1", "0.2.0-rc.1a", "10.0.0", "1.0.0-rc.02", "1.0.0+build", ""}
	for _, a := range vers {
		add("parseSemver:"+a, val(floats(ParseSemver(a))))
	}
	for _, a := range vers {
		for _, b := range vers {
			add("isNewer:"+a+"|"+b, val(IsNewer(a, b)))
		}
	}

	// textCursor
	type mtc struct {
		prev, in string
		br       []float64
		kind     string
	}
	mts := []mtc{{"", "hi", nil, "segment"}, {"hi", "  ", []float64{3}, "segment"}, {"hello", "lo", nil, "segment"},
		{"hello", "hello world", []float64{1}, "segment"}, {"abc", "xyz", nil, "segment"}, {"abc def", " def ", nil, "final"},
		{"abc def", " def ", nil, "segment"}, {"你好", "世界", []float64{0}, "final"}, {"😀a", "b", nil, "segment"}}
	for i, m := range mts {
		br := m.br
		if br == nil {
			br = []float64{}
		}
		txt, nb := MergeAssistantText(m.prev, m.in, br, m.kind)
		add(fmt.Sprintf("mergeAssistantText:%d", i), val(objFromMap("text", txt, "breaks", floats(nb))))
	}
	evs := []*util.Obj{
		objFromMap("type", "text-delta", "text", "!"), objFromMap("type", "text", "text", "new"), objFromMap("type", "done", "text", "pre"),
		objFromMap("type", "tool", "id", "t"), objFromMap("type", "thinking", "text", "x", "textAt", 1.0), objFromMap("type", "thinking", "textAt", nil),
		objFromMap("type", "error", "message", "m"),
	}
	for i, ev := range evs {
		txt, nb, e := FoldAssistantEvent("pre😀", []float64{2}, ev)
		add(fmt.Sprintf("foldAssistantEvent:%d", i), val(objFromMap("text", txt, "breaks", floats(nb), "ev", e)))
	}

	// cliEnv
	for _, n := range []string{"NOMI_X", "NOMI_MOCK_Y", "COMPANION_A", "IG_B", "CD_", "MCP_SERVERS", "MCP_SERVERS_X", "PATH", "nomi_x", "ANTHROPIC_API_KEY"} {
		add("isNomiInternalEnv:"+n, val(IsNomiInternalEnv(n)))
	}
	add("buildCliEnv", val(BuildCliEnv(envObj("PATH", "/b", "NOMI_A", "1", "NOMI_MOCK_B", "2", "NO_COLOR", "0", "MCP_AUTO_CONNECT", "x", "Z", ""), envObj("NOMI_DSH_API_KEY", "k", "PATH", "/c"))))
	add("buildCliEnv:noextra", val(BuildCliEnv(envObj("B", "1", "A", "2"), nil)))

	// legacyCliKey
	for _, mode := range []string{"on", "off", "throw", "throwAvail"} {
		for _, enc := range []string{"", "aGVsbG8=", "aGVsbG8", "aGV sbG8=", "YQ==YQ==", "a-_b", "5L2g5aW9", "/w==", "Zg"} {
			add("legacyCliKey:"+mode+":"+enc, val(LegacyCliKeyDecryptor(fakeSecrets{mode})(enc)))
		}
	}

	// processTree（注入 pgrep / taskkill / kill 的 fixture）
	oldPgrep, oldTask, oldKill := runPgrep, runTaskkill, killPid
	defer func() { runPgrep, runTaskkill, killPid = oldPgrep, oldTask, oldKill }()
	var calls []any
	tree := map[int]string{}
	runPgrep = func(pid int) (string, error) {
		calls = append(calls, []any{"pgrep", []any{"-P", strconv.Itoa(pid)}})
		s, ok := tree[pid]
		if !ok {
			return "", errors.New("exit 1")
		}
		return s, nil
	}
	runTaskkill = func(args []string) {
		a := make([]any, len(args))
		for i, s := range args {
			a[i] = s
		}
		calls = append(calls, []any{"taskkill", a, objFromMap("timeout", float64(taskkillTimeoutMs), "stdio", taskkillStdio)})
	}
	var kills []any
	killPid = func(pid int, sig string) error {
		kills = append(kills, []any{float64(pid), sig})
		if pid == 13 {
			return errors.New("ESRCH")
		}
		return nil
	}
	treeCase := func(name string, pid int, tr map[int]string) {
		calls, kills, tree = []any{}, []any{}, tr
		c := &fakeTreeChild{pid: pid}
		KillProcessTree(c)
		log := c.log
		if log == nil {
			log = []any{}
		}
		add("killProcessTree:"+name, val(objFromMap("calls", calls, "kills", kills, "childKill", log)))
	}
	treeCase("nopid", 0, map[int]string{})
	treeCase("leaf", 10, map[int]string{})
	treeCase("tree", 10, map[int]string{10: "11\n12\n", 11: "13\n", 12: "x\n\n0\n14 \n", 13: "", 14: "-1\n1.5\n"})
	treeCase("throwing", 99, map[int]string{99: "13\n"})
	calls, tree = []any{}, map[int]string{1: "2\n", 2: "3\n", 3: "4\n", 4: "5\n"}
	ds := ListDescendants(1, 2)
	dsa := []any{}
	for _, d := range ds {
		dsa = append(dsa, float64(d))
	}
	add("listDescendants:depth2", val(objFromMap("out", dsa, "calls", calls)))
	runPgrep, runTaskkill, killPid = oldPgrep, oldTask, oldKill

	// shellPath
	for i, s := range []string{"x__NOMI_PATH_START__/a:/b__NOMI_PATH_END__y", "__NOMI_PATH_START__1__NOMI_PATH_END__ __NOMI_PATH_START__ /z \n__NOMI_PATH_END__",
		"__NOMI_PATH_START__no end", "nothing", "__NOMI_PATH_START__  __NOMI_PATH_END__", "__NOMI_PATH_END____NOMI_PATH_START__q__NOMI_PATH_END__"} {
		add(fmt.Sprintf("parseShellPath:%d", i), val(strOrNull(ParseShellPath(s))))
	}
	add("mergePath:colon", val(MergePath("/a:/b::/a", " /c :/b:/d", ":")))
	add("mergePath:semi", val(MergePath(`C:\a;C:\b`, `C:\b;;C:\c`, ";")))
	dl := string(os.PathListSeparator)
	add("mergePath:default", val(MergePath("a"+dl+"b", "b"+dl+"c", "")))
	add("LOGIN_SHELL_ARGS", val(LoginShellArgs))
	{
		ResetShellPathForTest()
		before := os.Getenv("PATH")
		var added []string
		jsrt.Run(func() {
			_, _ = jsrt.Await(LoadLoginShellPath(func(a []string) { added = append(added, a...) }, LoadLoginShellPathOpts{
				Run: func(string, []string) string {
					return strings.Join([]string{"/x/new1", strings.Split(before, dl)[0], "/x/new2"}, dl)
				},
			}))
		})
		after := os.Getenv("PATH")
		os.Setenv("PATH", before)
		var a any = added
		if isWin {
			a = nil
		}
		add("loadLoginShellPath", val(objFromMap("added", a, "changed", after != before)))
		ResetShellPathForTest()
	}

	// cliHomes / cliTokens
	H := "/home/u"
	envs := []*util.Obj{envObj(), envObj("CLAUDE_CONFIG_DIR", "~", "CODEX_HOME", "~/cx", "GEMINI_CLI_HOME", ` ~\g `, "QWEN_HOME", "/abs/q", "OPENCODE_HOME", "", "XDG_DATA_HOME", "~/xdg", "COPILOT_HOME", "  ", "KIMI_HOME", "~/k", "KIMI_CODE_HOME", "/kc", "GROK_HOME", "/g/"), envObj("OPENCODE_HOME", "~/oc")}
	for i, e := range envs {
		add(fmt.Sprintf("cliHomes:%d", i), val(objFromMap("claude", usage.ClaudeConfigDir(H, e), "codex", usage.CodexHomeDir(H, e), "gemini", usage.GeminiDir(H, e),
			"qwen", usage.QwenDir(H, e), "opencode", usage.OpencodeDir(H, e), "copilot", usage.CopilotDir(H, e), "kimi", usage.KimiDirs(H, e), "grok", usage.GrokHomeDir(H, e))))
	}
	fp := func(f float64) *float64 { return &f }
	for _, q := range []struct {
		c, key string
		in, cr *float64
	}{{"codex", `{"inputTokens":10,"cacheReadTokens":3}`, fp(10), fp(3)}, {"codex", `{"inputTokens":1,"cacheReadTokens":3}`, fp(1), fp(3)},
		{"codex", `{"inputTokens":5}`, fp(5), nil}, {"claude", `{"inputTokens":10,"cacheReadTokens":3}`, fp(10), fp(3)}, {"codex", `{}`, nil, nil}} {
		r := usage.QualityLedgerInput(q.c, q.in, q.cr)
		if r == nil {
			add("qualityLedgerInput:"+q.c+":"+q.key, outcome{undef: true})
		} else {
			add("qualityLedgerInput:"+q.c+":"+q.key, val(*r))
		}
	}

	// limitedProcess 纯函数 + fs
	shim := func(cmd string, args []string, env *util.Obj) outcome {
		f, a, ok := usage.WindowsShimLaunch(cmd, args, env)
		if !ok {
			return val(nil)
		}
		return val(objFromMap("file", f, "args", a))
	}
	add("windowsShimLaunch:plain", shim(`C:\x\a.cmd`, []string{"--tools", "", "a b"}, envObj()))
	add("windowsShimLaunch:comspec", shim("a.cmd", nil, envObj("ComSpec", `C:\W\cmd.exe`)))
	for _, bad := range []string{"a\"b", "a%b", "a\nb", "a\rb"} {
		add("windowsShimLaunch:bad:"+util.Stringify(bad), shim("a.cmd", []string{bad}, envObj()))
	}
	for _, f := range []string{"npm/claude.cmd", "npm/nojs.cmd", "npm/missing.cmd", "npm/bad%.cmd", "npm2/tool.bat", "npm3/x.cmd", "npm/none.cmd", "bin/claude", "npm/CLAUDE.CMD"} {
		n, s, ok := usage.UnwrapWindowsCmdShim(p(f), usage.UnwrapCmdDeps{})
		if ok {
			add("unwrapWindowsCmdShim:"+f, val(objFromMap("node", n, "script", s)))
		} else {
			add("unwrapWindowsCmdShim:"+f, val(nil))
		}
	}
	launch := func(l *usage.CliLaunch) outcome {
		if l == nil {
			return val(nil)
		}
		return val(objFromMap("file", l.File, "args", l.Args, "via", string(l.Via)))
	}
	for _, plat := range []string{"win32", "linux"} {
		for _, f := range []string{"npm/claude.cmd", "npm/nojs.cmd", "npm/missing.cmd", "bin/codex.exe"} {
			add("resolveCliLaunch:"+plat+":"+f, launch(usage.ResolveCliLaunch(p(f), []string{"-p", ""}, envObj("ComSpec", "CS"), plat, usage.UnwrapCmdDeps{})))
		}
	}
	add("resolveCliLaunch:win32:quote", launch(usage.ResolveCliLaunch(p("npm/nojs.cmd"), []string{"a\"b"}, envObj(), "win32", usage.UnwrapCmdDeps{})))

	// detect
	for _, plat := range []string{"win32", "linux"} {
		for _, f := range []string{"bin/claude", "bin/codex", "bin/dsh", "bin/claude.CMD", "bin2/grok", "bin/none"} {
			add("windowsExecutable:"+plat+":"+f, val(strOrNull(WindowsExecutable(p(f), plat, nil))))
		}
	}
	for _, plat := range []string{"win32", "darwin"} {
		add("npmPrefixBinDir:"+plat, val(NpmPrefixBinDir("/p", plat)))
	}
	pathEnv := func(dirs []string, extra ...string) *util.Obj {
		ps := []string{}
		for _, d := range dirs {
			ps = append(ps, p(d))
		}
		o := envObj("Path", strings.Join(ps, dl))
		for i := 0; i+1 < len(extra); i += 2 {
			o.Set(extra[i], extra[i+1])
		}
		return o
	}
	for _, plat := range []string{"win32", "linux"} {
		for _, c := range []string{"claude", "codex", "dsh", "grok", "node", "claude.cmd", "none", "cli.js"} {
			add("findOnPath:"+plat+":"+c, val(strOrNull(FindOnPath(c, pathEnv([]string{"bin", "bin2", "npm/pkg"}), plat, nil))))
		}
		add("findOnPath:"+plat+":pathext", val(strOrNull(FindOnPath("claude", pathEnv([]string{"bin"}, "PATHEXT", "CMD; .EXE;;"), plat, nil))))
		add("findOnPath:"+plat+":empty", val(strOrNull(FindOnPath("claude", envObj("PATH", ""), plat, nil))))
	}
	for _, plat := range []string{"win32", "linux"} {
		add("cliSearchDirs:"+plat+":bare", val(CliSearchDirs(p("home"), plat, envObj())))
		add("cliSearchDirs:"+plat+":env", val(CliSearchDirs(p("home"), plat, envObj(
			"USERPROFILE", " "+p("home")+" ", "APPDATA", "", "LOCALAPPDATA", p("lad"), "NPM_CONFIG_PREFIX", " /np ", "PNPM_HOME", "/pn", "VOLTA_HOME", "/vo",
			"NVM_BIN", "/nvm/bin", "NVM_DIR", p("home/.nvm")))))
	}
	add("withCliPath", val(WithCliPath(envObj("HOME", p("home"), "USERPROFILE", p("home"), "APPDATA", p("home/AppData/Roaming"), "path", p("home/.local/bin")+dl+"/zz", "X", "1"))))
	add("withCliPath:nopath", val(WithCliPath(envObj("HOME", p("home"), "USERPROFILE", p("home")))))
	for _, b := range []string{"null", "/usr/lib/node_modules/x", `C:\Users\u\AppData\Roaming\npm-global\claude`, "/h/.nvm/versions/node/v20/bin/claude", "/h/.local/share/claude/versions/1/claude",
		"/h/.volta/bin/c", "/opt/fnm/c", "/h/.asdf/shims/c", "/h/mise/c", "/h/pnpm/c", "/h/.bun/bin/c", "/h/.npm-packages/c", "/x/versions/c", "/usr/local/bin/claude", `C:\X\PNPM\c`} {
		in := b
		if b == "null" {
			in = ""
		}
		add("guessInstallMethod:"+b, val(GuessInstallMethod(in)))
	}
	for _, v := range []string{"24.0.0", "23.9.9", "", "x.1", "100.0.0", "null"} {
		in := &v
		if v == "null" {
			in = nil
		}
		pr := DshRuntimeProblem(in)
		if pr == nil {
			add("dshRuntimeProblem:"+v, val(nil))
		} else {
			var nv any
			if pr.NodeVersion != nil {
				nv = *pr.NodeVersion
			}
			add("dshRuntimeProblem:"+v, val(objFromMap("nodeVersion", nv, "required", float64(pr.Required))))
		}
	}
	np := util.NewObj()
	for _, k := range []string{"claude", "codex", "dsh", "grok", "gemini"} {
		np.Set(k, NpmPkg[k])
	}
	add("NPM_PKG", val(np))
	mn := util.NewObj()
	for _, k := range []string{"claude", "codex", "dsh", "grok", "gemini"} {
		mn.Set(k, float64(CliMinNodeMajor[k]))
	}
	add("CLI_MIN_NODE_MAJOR", val(mn))

	// cliLaunch
	for _, plat := range []string{"win32", "linux"} {
		for _, c := range []struct{ f, nb string }{{"npm/claude", "/n/node"}, {"npm/claude.cmd", "null"}, {"npm/nojs", "/n/node"}, {"npm3/x.cmd", "/n/node"}, {"bin/codex", "null"}, {"npm/missing.cmd", "/n/node"}} {
			nb := c.nb
			if c.nb == "null" {
				nb = ""
			}
			l := ResolveHarnessLaunch(p(c.f), []string{"a"}, envObj("HOME", p("home"), "USERPROFILE", p("home"), "PATH", "/p"), plat, &nb)
			o := objFromMap("file", l.File, "args", l.Args, "env", l.Env)
			o.Set("verbatim", l.Verbatim)
			add("resolveHarnessLaunch:"+plat+":"+c.f+":"+c.nb, val(o))
		}
	}

	// grokAuth 解析
	grokTexts := []string{
		`{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"}]}}`,
		"log\n{\"result\":{\"authMethods\":[],\"_meta\":{\"defaultAuthMethodId\":\"oauth\"}}}\r\n",
		`{"authMethods":[{"id":"x"}],"defaultAuthMethodId":"xai-api-key"}`,
		`{"authMethods":[{"id":"x"}],"_meta":{"defaultAuthMethodId":"grok.com"}}`,
		`{"authMethods":[{"id":"x"}],"_meta":{"defaultAuthMethodId":5},"defaultAuthMethodId":"deployment"}`,
		`{"authMethods":[{"id":"cached-token"}],"defaultAuthMethodId":"other"}`,
		`{"authMethods":"no"}`, "not json", "", "[1]", `{"result":{"result":{"authMethods":[{"id":"CachedToken"}]}}}`,
		`  {"authMethods":[{"id":"cachedtoken"}]}  `, "{\"a\":1}\n{\"authMethods\":[{\"id\":\"env_key\"}],\"defaultAuthMethodId\":\"ENV-KEY\"}",
	}
	for i, s := range grokTexts {
		add(fmt.Sprintf("parseGrokAuthStatus:%d", i), val(strOrNull(usage.ParseGrokAuthStatus(s))))
	}

	// 真实子进程往返
	env := usage.ProcessEnv()
	env.Set("NOMI_TEST_NODE", node)
	env.Set("NOMI_X", "v")
	pathOf := func(e *util.Obj) string {
		if s, ok := e.Get("PATH").(string); ok {
			return s
		}
		s, _ := e.Get("Path").(string)
		return s
	}
	withNodePath := func(sep string) *util.Obj {
		e := env.Clone()
		e.Set("PATH", filepath.Dir(node)+sep+pathOf(env))
		return e
	}
	runL := func(name, cmd string, args []string, o usage.RunOptions) {
		if o.Cwd == "" {
			o.Cwd = p("cwd")
		}
		if o.Env == nil {
			o.Env = env
		}
		if o.TimeoutMs == 0 {
			o.TimeoutMs = 8000
		}
		o.MaxBytes = 4096
		var r usage.RunResult
		var err error
		jsrt.Run(func() { r, err = jsrt.Await(usage.RunLimited(cmd, args, o)) })
		if err != nil {
			var pf *usage.ProcessFailure
			if errors.As(err, &pf) {
				add(name, outcome{err: err.Error(), kind: string(pf.Kind)})
			} else {
				add(name, outcome{err: err.Error()})
			}
			return
		}
		var code any
		if r.Code != nil {
			code = float64(*r.Code)
		}
		add(name, val(objFromMap("stdout", r.Stdout, "code", code)))
	}
	runL("runLimited:ok", node, []string{p("mock/echo.js"), "a b", "", "c\"d"}, usage.RunOptions{})
	runL("runLimited:exit3", node, []string{p("mock/exit3.js")}, usage.RunOptions{})
	runL("runLimited:limit", node, []string{p("mock/big.js")}, usage.RunOptions{})
	runL("runLimited:timeout", node, []string{p("mock/hang.js")}, usage.RunOptions{TimeoutMs: 300})
	runL("runLimited:missing", p("mock/nope-bin"), nil, usage.RunOptions{})
	runL("runLimited:badcwd", node, []string{"-v"}, usage.RunOptions{Cwd: p("nope")})
	if isWin {
		runL("runLimited:win:cmdshim", p("mock/shim.cmd"), []string{"x y", ""}, usage.RunOptions{})
		runL("runLimited:win:quoteReject", p("mock/shim.cmd"), []string{"a%b"}, usage.RunOptions{})
		runL("runLimited:win:unwrap", p("npm/claude.cmd"), []string{"q"}, usage.RunOptions{Env: withNodePath(";")})
	}
	grokBin := p("mock/grok")
	if isWin {
		grokBin = p("mock/grok.cmd")
	}
	grokCase := func(name string, d usage.GrokAuthReaderDeps) {
		var s string
		var ok bool
		jsrt.Run(func() { s, ok = usage.ReadGrokAuthStatus(d) })
		if ok {
			add(name, val(s))
		} else {
			add(name, val(nil))
		}
	}
	grokCase("readGrokAuthStatus:ok", usage.GrokAuthReaderDeps{ResolveBin: func() (string, bool) { return grokBin, true },
		Env: func() *util.Obj { return withNodePath(dl) }, TmpRoot: sb})
	grokCase("readGrokAuthStatus:nobin", usage.GrokAuthReaderDeps{ResolveBin: func() (string, bool) { return "", false }})
	grokCase("readGrokAuthStatus:throwbin", usage.GrokAuthReaderDeps{ResolveBin: func() (string, bool) { panic("x") }})
	grokCase("readGrokAuthStatus:timeout", usage.GrokAuthReaderDeps{ResolveBin: func() (string, bool) { return node, true },
		Env: func() *util.Obj { return env }, TmpRoot: sb, TimeoutMs: 400})
	left := []any{}
	ents, _ := os.ReadDir(sb)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "nomi-grok-auth-") {
			left = append(left, e.Name())
		}
	}
	add("readGrokAuthStatus:tmpClean", val(left))

	// sqliteRead（Go 侧用同样的建表 / 插入重建数据库）
	sqliteOK := false
	for _, c := range g.cases {
		if c.Get("name") == "sqlite:available" {
			sqliteOK, _ = c.Get("out").(*util.Obj).Get("v").(bool)
		}
	}
	add("sqlite:available", val(sqliteOK))
	if sqliteOK {
		writeOpencodeFixture(t, p("oc.db"))
		add("readOpencodeRows:200", val(usage.ReadOpencodeRows(p("oc.db"), 200)))
		add("readOpencodeRows:0", val(usage.ReadOpencodeRows(p("oc.db"), 0)))
		add("readCopilotRows:1", val(usage.ReadCopilotRows(p("oc.db"), 1)))
		add("readCopilotRows:0.5", val(usage.ReadCopilotRows(p("oc.db"), 0.5)))
	}
	add("readOpencodeRows:missing", val(usage.ReadOpencodeRows(p("none.db"), 0)))
	add("readCopilotRows:wrongSchema", val(usage.ReadCopilotRows(p("mock/echo.js"), 0)))
	sig, ok := usage.DBSignature(p("none.db"))
	if ok {
		add("dbSignature:missing", val(sig))
	} else {
		add("dbSignature:missing", val(nil))
	}
	add("DB_BATCH", val(float64(usage.DBBatch)))

	// 比对
	n := 0
	for _, c := range g.cases {
		name := c.Get("name").(string)
		want := c.Get("out").(*util.Obj)
		o, ok := got[name]
		if !ok {
			t.Errorf("%s: no Go case", name)
			continue
		}
		n++
		gotObj := util.NewObj()
		switch {
		case o.err != "":
			gotObj.Set("err", o.err)
			if o.kind != "" {
				gotObj.Set("kind", o.kind)
			}
		case o.undef:
			gotObj.Set("undef", true)
		default:
			gotObj.Set("v", unsub(o.v, sb, node))
		}
		if ws, gs := util.Stringify(want), util.Stringify(gotObj); ws != gs {
			t.Errorf("%s:\n node %s\n   go %s", name, ws, gs)
		}
	}
	if len(got) != len(g.cases) {
		t.Errorf("Go ran %d cases, golden has %d", len(got), len(g.cases))
	}
	t.Logf("compared %d cli cases (%s)", n, g.platform)
}

func writeOpencodeFixture(t *testing.T, file string) {
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	stmts := []string{
		`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`,
		`CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
	msgs := [][]any{
		{"m1", "s1", 100.0, 200.0, `{"role":"assistant","modelID":"gpt","providerID":"oa","time":{"created":150},"tokens":{"input":1,"output":2,"reasoning":0.5,"cache":{"read":3,"write":4}},"path":{"cwd":"/w"}}`},
		{"m2", "s1", 101.0, 300.0, `{"role":"assistant"}`},
		{"m3", "s1", 102.0, 250.0, `{"role":"user"}`},
		{"m4", "s2", 103.0, 199.0, `{"role":"assistant"}`},
		{"m5", "s2", 104.0, 400.0, "not json"},
	}
	for _, m := range msgs {
		if _, err := db.Exec(`INSERT INTO message VALUES (?,?,?,?,?)`, m...); err != nil {
			t.Fatal(err)
		}
	}
	for _, u := range [][]any{{1.0, "s", "m", 1.0, 2.0, 3.0, 4.0, "2025-01-01"}, {2.0, "s", nil, 10.0, 20.0, nil, nil, nil}, {5.0, "t", "m2", 0.0, 0.0, 0.0, 0.0, "x"}} {
		if _, err := db.Exec(`INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?)`, u...); err != nil {
			t.Fatal(err)
		}
	}
}
