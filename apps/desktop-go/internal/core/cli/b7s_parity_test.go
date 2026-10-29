package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// b7sCase 逐条记录 Go 侧结果（与 record-b7s.mjs 的 {v}/{undef}/{err,name} 同形）。
type b7sRec struct {
	order []string
	got   map[string]*util.Obj
}

func (r *b7sRec) add(name string, v any, err error) {
	var o *util.Obj
	if err != nil {
		o = util.NewObj("err", err.Error())
		if n, ok := err.(interface{ Name() string }); ok && n.Name() != "Error" {
			o.Set("name", n.Name())
		}
	} else {
		o = util.NewObj("v", v)
	}
	r.order = append(r.order, name)
	r.got[name] = o
}

func strPtr(s string) *string { return &s }

func b7sScrub(txt, SB string) string {
	esc := func(x string) string { s := util.Stringify(x); return s[1 : len(s)-1] }
	fwd := strings.ReplaceAll(SB, `\`, "/")
	for _, f := range []string{esc(strings.ToLower(fwd)), esc(fwd), esc(SB)} {
		txt = strings.ReplaceAll(txt, f, "<SB>")
	}
	return txt
}

func TestB7sGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s.json", filepath.Join("testdata", "b7s.json"))
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
	node := findNode(t)
	root, _ := filepath.Abs(filepath.Join("..", "..", "..", "..", ".."))
	SB, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rec := &b7sRec{got: map[string]*util.Obj{}}
	w := func(rel, s string) string {
		p := filepath.Join(SB, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o777)
		if err := os.WriteFile(p, []byte(s), 0o666); err != nil {
			t.Fatal(err)
		}
		return p
	}

	/* ---------------- modelDiscovery ---------------- */
	spawner := func(env map[string]string, script string) func(string, []string) clisdk.ChildLike {
		return func(backend string, args []string) clisdk.ChildLike {
			if script == "none" {
				return nil
			}
			file := script
			if file == "" {
				file = filepath.Join(root, "packages/core/scripts/mock-cli", "mock-"+backend+".mjs")
			}
			e := []string{"PATH=" + os.Getenv("PATH")}
			for k, v := range env {
				e = append(e, k+"="+v)
			}
			return clisdk.ProcChild{Child: nodeproc.Spawn(node, append([]string{file}, args...), nodeproc.Options{Cwd: root, Env: e})}
		}
	}
	settings := w("claude/settings.json", `{"effortLevel":"medium"}`)
	badSettings := w("claude/bad.json", "{")
	codexCfg := w("codex/config.toml", "model = \"gpt-mock-mini\"\nmodel_reasoning_effort = 'low'\n[x]\nmodel=\"no\"\n")
	grokCache := w("grok/models_cache.json", `{"models":{"availableModels":[{"modelId":"grok-mock-old","name":"Old"},{"modelId":"grok-cache-only","name":"Cache Only"}]}}`)
	grokSettings := w("grok/settings_cache.json", util.Stringify(util.NewObj("payload", `{"settings":{"default_model":"grok-cache-only"}}`)))
	grokSettings2 := w("grok/settings2.json", `{"payload":{"default_model":"nope"}}`)
	silent := w("silent.mjs", "process.stdin.resume(); setInterval(() => {}, 1000);\n")
	dies := w("dies.mjs", "process.stderr.write(\"line1\\nline2\\nline3\\nboom: policy locked\\n\"); process.exit(3);\n")
	garbage := w("garbage.mjs", "process.stdout.write(\"not json\\n\"); process.exit(0);\n")
	t400 := 400
	D := func(d ModelDiscoveryDeps) ModelDiscoveryDeps {
		if d.CodexConfigPath == "" {
			d.CodexConfigPath = filepath.Join(SB, "missing.toml")
		}
		return d
	}
	disc := func(name, backend string, deps ModelDiscoveryDeps) {
		var pr *jsrt.Promise[*util.Obj]
		// 经 ports 适配器走一遍（同 Orchestrator 的接法）
		dd := D(deps)
		ad := ModelDiscoveryAdapter{Paths: func(string) ModelDiscoveryPaths {
			return ModelDiscoveryPaths{dd.ClaudeDefaults, dd.CodexConfigPath, dd.GrokModelsCachePath, dd.GrokSettingsCachePath}
		}}
		pd := ports.ModelDiscoveryDeps{Spawn: func(b string, a []string) (clisdk.ChildLike, error) { return dd.Spawn(b, a), nil }}
		if dd.TimeoutMs != nil {
			f := float64(*dd.TimeoutMs)
			pd.TimeoutMs = &f
		}
		jsrt.Run(func() { pr = ad.DiscoverModels(backend, pd) })
		select {
		case <-pr.Done():
		case <-time.After(60 * time.Second):
			t.Fatalf("%s: hung", name)
		}
		v, err := pr.Result()
		rec.add("md:"+name, v, err)
	}
	mk := map[string]string{}
	disc("claude", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, "")})
	disc("claude:env", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, ""), ClaudeDefaults: &ClaudeDefaults{EffortEnv: strPtr(" high "), SettingsPath: &settings}})
	disc("claude:envAuto", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, ""), ClaudeDefaults: &ClaudeDefaults{EffortEnv: strPtr("auto"), SettingsPath: &settings}})
	disc("claude:badSettings", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, ""), ClaudeDefaults: &ClaudeDefaults{SettingsPath: &badSettings}})
	disc("claude:none", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, "none")})
	disc("claude:dies", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, dies)})
	disc("claude:timeout", "claude", ModelDiscoveryDeps{Spawn: spawner(mk, silent), TimeoutMs: &t400})
	disc("codex", "codex", ModelDiscoveryDeps{Spawn: spawner(mk, ""), CodexConfigPath: codexCfg})
	disc("codex:noCfg", "codex", ModelDiscoveryDeps{Spawn: spawner(mk, "")})
	disc("codex:fail", "codex", ModelDiscoveryDeps{Spawn: spawner(map[string]string{"NOMI_MOCK_MODELS_FAIL": "1"}, "")})
	disc("codex:garbage", "codex", ModelDiscoveryDeps{Spawn: spawner(mk, garbage)})
	disc("codex:dies", "codex", ModelDiscoveryDeps{Spawn: spawner(mk, dies)})
	disc("grok", "grok", ModelDiscoveryDeps{Spawn: spawner(mk, "")})
	disc("grok:cache", "grok", ModelDiscoveryDeps{Spawn: spawner(mk, ""), GrokModelsCachePath: grokCache})
	noAcp := map[string]string{"NOMI_MOCK_GROK_NO_ACP": "1"}
	disc("grok:noAcp", "grok", ModelDiscoveryDeps{Spawn: spawner(noAcp, "")})
	disc("grok:noAcp:cache", "grok", ModelDiscoveryDeps{Spawn: spawner(noAcp, ""), GrokModelsCachePath: grokCache, GrokSettingsCachePath: grokSettings})
	disc("grok:noAcp:cache2", "grok", ModelDiscoveryDeps{Spawn: spawner(noAcp, ""), GrokModelsCachePath: grokCache, GrokSettingsCachePath: grokSettings2})
	disc("grok:none:cache", "grok", ModelDiscoveryDeps{Spawn: spawner(mk, "none"), GrokModelsCachePath: grokCache})
	disc("grok:timeout", "grok", ModelDiscoveryDeps{Spawn: spawner(mk, silent), TimeoutMs: &t400})
	disc("gemini", "gemini", ModelDiscoveryDeps{Spawn: spawner(mk, "")})
	missing := filepath.Join(SB, "nope.json")
	for _, c := range []struct {
		n  string
		cd *ClaudeDefaults
	}{{"none", nil}, {"env", &ClaudeDefaults{EffortEnv: strPtr("max")}}, {"blank", &ClaudeDefaults{EffortEnv: strPtr("  ")}},
		{"file", &ClaudeDefaults{SettingsPath: &settings}}, {"missing", &ClaudeDefaults{SettingsPath: &missing}}, {"bad", &ClaudeDefaults{SettingsPath: &badSettings}}} {
		s, ok := ClaudeConfiguredEffort(ModelDiscoveryDeps{ClaudeDefaults: c.cd})
		rec.add("md:effort:"+c.n, nullStr(s, ok), nil)
	}

	/* ---------------- gemini ---------------- */
	for _, ms := range []int{0, 499, 500, 1500, 2500, 60000, 90_499} {
		rec.add("acp:msg:"+util.FormatNumber(float64(ms)), gemini.AcpTimeoutMessage("x", ms), nil)
	}
	ip := func(i int) *int { return &i }
	for _, c := range []struct {
		code *int
		err  string
	}{{ip(55), ""}, {ip(1), "Gemini CLI is not running in a trusted directory"}, {ip(1), "x"}, {nil, "not running in a trusted directory"}, {ip(0), ""}} {
		cs := "null"
		if c.code != nil {
			cs = util.FormatNumber(float64(*c.code))
		}
		rec.add("trust:exit:"+cs+":"+c.err, gemini.IsGeminiUntrustedExit(c.code, c.err), nil)
	}
	rec.add("trust:msg", gemini.GeminiUntrustedMessage("/a/b"), nil)
	ue := gemini.NewUntrustedError("/a", os.ErrClosed).(*gemini.UntrustedError)
	rec.add("trust:err", util.NewObj("name", ue.Name(), "message", ue.Error(), "folder", ue.Folder), nil)
	le := util.NewObj()
	for _, kv := range gemini.GeminiLoginEnv("/stage") {
		le.Set(kv[0], kv[1])
	}
	rec.add("trust:loginEnv", le, nil)

	envOf := func(kv ...string) *util.Obj {
		o := util.NewObj()
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i], kv[i+1])
		}
		return o
	}
	for _, e := range []*util.Obj{envOf(), envOf("GEMINI_CLI_TRUST_WORKSPACE", "false"), envOf("GEMINI_RESTRICTED_MODE", "true"), envOf("GEMINI_CLI_TRUST_WORKSPACE", "true")} {
		s := gemini.GeminiTrustBlockedByEnv(e)
		rec.add("tf:blocked:"+util.Stringify(e), nullStr(s, s != ""), nil)
	}
	rec.add("tf:path:default", gemini.GeminiTrustedFoldersPath("/home/u", envOf()), nil)
	rec.add("tf:path:explicit", gemini.GeminiTrustedFoldersPath("/home/u", envOf("GEMINI_CLI_TRUSTED_FOLDERS_PATH", "  /x/y.json ")), nil)
	rec.add("tf:path:cliHome", gemini.GeminiTrustedFoldersPath("/home/u", envOf("GEMINI_CLI_HOME", "/gh")), nil)
	t.Chdir(SB)
	PATHS := []string{"/a/B", "/a/b/", "/a/./b/../c", "rel/x", `C:\Users\Me`, "c:/users/me/", `\\srv\share\x`, "/"}
	for _, pl := range []string{"linux", "darwin", "win32"} {
		for _, p := range PATHS {
			rec.add("tf:key:"+pl+":"+p, gemini.GeminiPathKey(p, pl), nil)
		}
	}
	for _, s := range []string{`{"a":1}`, "// c\n{\"a\":\"//x\"} /* y */", `{"a":"\"/*"}`, "/* open", `"unterminated \`, `{"k": "v"} // tail`} {
		rec.add("tf:strip:"+util.Stringify(s), gemini.StripJsonComments(s), nil)
	}
	for _, c := range []struct {
		pl, f, h string
		extra    []string
	}{
		{"linux", "/", "/home/u", nil}, {"linux", "/home/u", "/home/u", nil}, {"linux", "/home/u/Documents", "/home/u", nil}, {"linux", "/home/u/p/x", "/home/u", nil},
		{"linux", "/home", "/home/u", nil}, {"linux", "/srv/conv", "/home/u", []string{"/srv/conv", ""}}, {"darwin", "/Users/U/Desktop", "/users/u", nil},
		{"win32", `C:\`, `C:\Users\me`, nil}, {"win32", `c:\users\ME`, `C:\Users\me`, nil}, {"win32", `D:\proj\a`, `C:\Users\me`, nil}, {"win32", `C:\Users\me\Downloads`, `C:\Users\me`, nil},
	} {
		rec.add("tf:broad:"+c.pl+":"+c.f, gemini.IsBroadGeminiFolder(c.f, c.h, c.extra, c.pl), nil)
	}

	proj := filepath.Join(SB, "proj", "Repo")
	_ = os.MkdirAll(proj, 0o777)
	tfFile := filepath.Join(SB, "gh", ".gemini", "trustedFolders.json")
	envT := envOf("GEMINI_CLI_HOME", filepath.Join(SB, "gh"))
	read := func() any {
		b, err := os.ReadFile(tfFile)
		if err != nil {
			return nil
		}
		return string(b)
	}
	tr := func(name, folder string, env *util.Obj) {
		r, err := GeminiTrustAdapter{}.TrustGeminiFolder(folder, SB, env, usage.Platform())
		if err != nil {
			rec.add("tf:trust:"+name, nil, err)
			return
		}
		var prev any
		if r.Previous != nil {
			prev = *r.Previous
		}
		rec.add("tf:trust:"+name, util.NewObj("r", util.NewObj("folder", r.Folder, "file", r.File, "previous", prev), "file", read()), nil)
	}
	tr("blocked", proj, envT.Clone().Set("GEMINI_RESTRICTED_MODE", "true"))
	tr("relative", "proj", envT)
	tr("missing", filepath.Join(SB, "nope"), envT)
	tr("notDir", settings, envT)
	tr("fresh", proj, envT)
	tr("again", proj, envT)
	_ = os.WriteFile(tfFile, []byte("// keep\n{ \""+strings.ReplaceAll(proj, `\`, `\\`)+"\": \"DO_NOT_TRUST\", \"/other\": \"TRUST_PARENT\" }\n"), 0o666)
	tr("flip", proj, envT)
	_ = os.WriteFile(tfFile, []byte("[1]"), 0o666)
	tr("malformed", proj, envT)
	_ = os.WriteFile(tfFile, []byte("   "), 0o666)
	tr("blank", proj, envT)
	_ = os.Remove(tfFile)
	_ = os.MkdirAll(tfFile+".lock", 0o777)
	old := time.Now().Add(-60 * time.Second)
	_ = os.Chtimes(tfFile+".lock", old, old)
	tr("staleLock", proj, envT)
	_, serr := os.Stat(tfFile + ".lock")
	rec.add("tf:trust:lockGone", serr == nil, nil)
	tr("explicitPath", proj, envOf("GEMINI_CLI_TRUSTED_FOLDERS_PATH", filepath.Join(SB, "deep", "dir", "t.json")))
	eb, _ := os.ReadFile(filepath.Join(SB, "deep", "dir", "t.json"))
	rec.add("tf:trust:explicitFile", string(eb), nil)

	/* ---------------- compare ---------------- */
	n := 0
	for _, c := range g.Get("cases").([]any) {
		co := c.(*util.Obj)
		name := co.Get("name").(string)
		got, ok := rec.got[name]
		if !ok {
			t.Errorf("%s: not run in Go", name)
			continue
		}
		want := util.Stringify(co.Get("out"))
		gs := b7sScrub(util.Stringify(got), SB)
		if gs != want {
			t.Errorf("%s\n got  %s\n want %s", name, gs, want)
		}
		n++
	}
	if n != len(rec.order) {
		t.Errorf("golden has %d cases, Go ran %d", n, len(rec.order))
	}
	t.Logf("b7s parity: %d cases", n)
}
