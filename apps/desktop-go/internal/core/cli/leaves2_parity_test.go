package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

func strsAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

func nullStr(s string, ok bool) any {
	if !ok {
		return nil
	}
	return s
}

// TestCliLeaves2Golden：record-b7-leaves2.mjs（permissionMode / modelCatalog / externalPlugins）逐条对比。
func TestCliLeaves2Golden(t *testing.T) {
	p, _ := paritytest.Golden(t, "leaves2.json", filepath.Join("testdata", "leaves2.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		t.Fatal(err)
	}
	g := v.(*util.Obj)
	if pl := g.Get("platform").(string); pl != usage.Platform() {
		t.Skipf("golden recorded on %s", pl)
	}
	SB := t.TempDir()
	if r, err := filepath.EvalSymlinks(SB); err == nil {
		SB = r
	}
	got := map[string]any{}
	type errv struct{ msg string }
	set := func(name string, v any) { got[name] = v }
	js := func(v any) string { return util.Stringify(v) }

	CLI := []string{"claude", "codex", "dsh", "grok", "gemini", "external"}
	ALL := append(append([]string{}, CLI...), "nomi")
	MODES := PermissionModes
	set("modes", strsAny(MODES))
	set("default", DefaultPermissionMode)
	for _, m := range append(strsAny(MODES), "x", "", float64(5), nil) {
		set("isMode:"+js(m), IsPermissionMode(m))
	}
	for _, b := range ALL {
		set("supported:"+b, strsAny(SupportedModes(b)))
		for _, m := range MODES {
			mm, d := EffectiveMode(b, m)
			set("effective:"+b+":"+m, util.NewObj("mode", mm, "degraded", d))
		}
	}
	tr, fa := true, false
	nets := []struct {
		n string
		p *bool
	}{{"undefined", nil}, {"true", &tr}, {"false", &fa}}
	raws := []any{"default", "acceptEdits", "plan", "bypassPermissions", "auto", "auto_edit", "yolo", "read-only",
		"workspace-write", "danger-full-access", "full-auto", "manual", "ask", "agent", "", "x", float64(5), nil}
	for _, b := range CLI {
		for _, m := range MODES {
			for _, n := range nets {
				l := PermissionLaunchFor(b, m, n.p)
				set("launch:"+b+":"+m+":"+n.n, util.NewObj("args", strsAny(l.Args), "env", l.Env))
			}
		}
		set("planPrefix:"+b, nullStr(PlanPromptPrefix(b)))
		for _, r := range raws {
			s := FromCliPermissionMode(b, r)
			set("fromCli:"+b+":"+js(r), nullStr(s, s != ""))
		}
	}
	for _, m := range MODES {
		set("claudeName:"+m, ClaudeModeName(m))
		set("geminiId:"+m, GeminiModeID(m))
		set("grokId:"+m, GrokModeID(m))
		set("acpId:external:"+m, AcpModeID("external", m))
	}

	models := []string{"gpt-5", "opus", "claude-sonnet-4-5[1m]", "", " x", "a b", "-rf", "a/b:c.d_e", strings.Repeat("x", 200)}
	for _, b := range append(append([]string{}, CLI...), "nomi", "zzz") {
		set("supportsModel:"+b, SupportsModelOverride(b))
		for _, m := range models {
			set("allowed:"+b+":"+m, IsAllowedModelID(b, m))
		}
	}
	empty, g5, opus := "", "gpt-5", "opus"
	mods := []struct {
		n string
		p *string
	}{{"undefined", nil}, {"null", nil}, {"", &empty}, {"gpt-5", &g5}, {"opus", &opus}}
	efs := []struct {
		n string
		v any
	}{{"undefined", nil}, {"null", nil}, {"low", "low"}, {"medium", "medium"}, {"high", "high"}, {"xhigh", "xhigh"}, {"minimal", "minimal"}, {"max", "max"}, {"bogus", "bogus"}}
	for _, b := range CLI {
		for _, m := range mods {
			for _, e := range efs {
				set("override:"+b+":"+m.n+":"+e.n, strsAny(OverrideArgs(b, m.p, e.v)))
			}
		}
	}

	// externalPlugins
	dir := filepath.Join(SB, "ext")
	store := NewExternalPluginStore(dir, []string{"claude", "codex"})
	stored := func(xs []StoredExternal) any {
		out := []any{}
		for _, x := range xs {
			var spec any
			if x.Spec != nil {
				spec = x.Spec
			}
			out = append(out, util.NewObj("id", x.ID, "spec", spec, "errors", strsAny(x.Errors)))
		}
		return out
	}
	set("ext:load:missing", stored(store.Load()))
	os.MkdirAll(dir, 0o755)
	base := func(id string) *util.Obj {
		return util.NewObj("version", float64(1), "id", id, "displayName", "My Agent", "command", "/usr/local/bin/my-agent",
			"args", []any{"acp", "--cwd", "{cwd}"}, "env", []any{"MY_AGENT_HOME"})
	}
	w := func(n, s string) { os.WriteFile(filepath.Join(dir, n), []byte(s), 0o644) }
	w("my-agent.json", js(base("my-agent")))
	w("bad.json", `{"id": `)
	w("bom.json", "\uFEFF"+js(base("bom")))
	w("mismatch.json", js(base("other")))
	w("claude.json", js(base("claude")))
	w("invalid.json", `{"id":"invalid"}`)
	w("arr.json", "[1,2]")
	w("Zed.json", js(base("Zed")))
	w("notes.txt", "x")
	os.Mkdir(filepath.Join(dir, "dir.json"), 0o755)
	set("ext:load", stored(store.Load()))
	save := func(raw any) any {
		spec, errs := store.Save(raw)
		if errs != nil {
			return util.NewObj("errors", strsAny(errs))
		}
		return util.NewObj("spec", spec)
	}
	ex := base("saved")
	ex.Set("extra", float64(1))
	set("ext:save:extra", save(ex))
	ok := base("saved")
	ok.Delete("env")
	set("ext:save:ok", save(ok))
	if fb, err := os.ReadFile(filepath.Join(dir, "saved.json")); err == nil {
		set("ext:save:file", string(fb))
	} else {
		set("ext:save:file", errv{err.Error()})
	}
	set("ext:save:reserved", save(base("codex")))
	set("ext:save:bad", save("nope"))
	set("ext:save:null", save(nil))
	for i, id := range []string{"saved", "saved", "dir", "../x", "Bad", strings.Repeat("a", 41), "bad"} {
		set("ext:remove:"+util.FormatNumber(float64(i))+":"+id, store.Remove(id))
	}
	set("ext:load:after", stored(store.Load()))

	n := 0
	for _, c := range g.Get("cases").([]any) {
		co := c.(*util.Obj)
		name := co.Get("name").(string)
		out := co.Get("out").(*util.Obj)
		gv, has := got[name]
		if !has {
			t.Errorf("%s: no Go case", name)
			continue
		}
		var want string
		if out.Get("undef") == true {
			want = "undefined"
		} else if e, ok := out.Lookup("err"); ok {
			want = "err:" + util.Str(e)
		} else {
			want = js(out.Get("v"))
		}
		var gs string
		if e, ok := gv.(errv); ok {
			gs = "err:" + strings.ReplaceAll(e.msg, SB, "<SB>")
		} else {
			gs = strings.ReplaceAll(js(gv), SB, "<SB>")
		}
		if gs != want {
			t.Errorf("%s:\n go:   %s\n node: %s", name, gs, want)
		}
		n++
	}
	if n != len(got) {
		t.Errorf("Go produced %d cases, golden has %d", len(got), n)
	}
	t.Logf("compared %d leaf2 cases (%s)", n, usage.Platform())
}
