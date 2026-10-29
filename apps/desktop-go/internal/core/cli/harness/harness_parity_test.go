package harness

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

var uuidRe = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// short = recorder 的 short()：UTF-16 长度 > 200 的字符串截成 前20…长度。
func short(v any) any {
	switch x := v.(type) {
	case string:
		if n := clisdk.Len(x); n > 200 {
			return x[:20] + "…" + util.FormatNumber(float64(n))
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = short(e)
		}
		return out
	case *util.Obj:
		o := util.NewObj()
		for _, k := range x.Keys() {
			o.Set(k, short(x.Get(k)))
		}
		return o
	}
	return v
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func imgsAny(ims []cli.NormalizedImage) []any {
	out := []any{}
	for _, im := range ims {
		out = append(out, im.Obj())
	}
	return out
}

func inspectObj(ims []cli.NormalizedImage, rej []cli.RejectedImage) *util.Obj {
	r := []any{}
	for _, x := range rej {
		r = append(r, util.NewObj("index", float64(x.Index), "reason", x.Reason))
	}
	return util.NewObj("images", imgsAny(ims), "rejected", r)
}

// TestHarnessGolden：record-b7-harness.mjs 逐条对比。
func TestHarnessGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "harness.json", filepath.Join("testdata", "harness.json"))
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
	fx := g.Get("fixtures").(*util.Obj)
	SB := t.TempDir()
	if r, err := filepath.EvalSymlinks(SB); err == nil {
		SB = r
	}
	got := map[string]any{}
	order := []string{}
	set := func(name string, v any) {
		if _, dup := got[name]; !dup {
			order = append(order, name)
		}
		got[name] = v
	}
	js := util.Stringify
	old := NowMs
	NowMs = func() float64 { return 1000 }
	defer func() { NowMs = old }()

	// permissionQueue
	for _, s := range []any{nil, "", "ExitPlanMode", "exit_plan_mode", "exit-plan-mode", "exitPlanMode", "ExitPlanMode: do it", "exit plan", "EXIT_PLAN_MODE", "Bash", "exitplanmode x"} {
		str, _ := s.(string)
		name := "isExit:undefined"
		if s != nil {
			name = "isExit:" + js(s)
		}
		set(name, IsExitPlanTool(str))
	}
	for _, c := range []string{"acceptEdits", "manual", "deny", "x"} {
		set("approve:"+c, nullable(ApprovePlanMode(c)))
	}
	evs := []struct {
		k  string
		ev func() *util.Obj
	}{
		{"text", func() *util.Obj { return util.NewObj("type", "text", "text", "x") }},
		{"perm", func() *util.Obj { return util.NewObj("type", "permission", "id", "p", "summary", "Bash: ls") }},
		{"permExp", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "s", "expiresAt", float64(5))
		}},
		{"exitSum", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "ExitPlanMode: plan here")
		}},
		{"exitSumSp", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "exit_plan_mode\tplan")
		}},
		{"exitTool", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "plan", "toolName", "ExitPlanMode")
		}},
		{"kindTool", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "ExitPlanMode", "kind", "tool")
		}},
		{"kindPlan", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "x", "kind", "approve-plan")
		}},
		{"toolBash", func() *util.Obj {
			return util.NewObj("type", "permission", "id", "p", "summary", "ExitPlanMode", "toolName", "Bash")
		}},
	}
	for _, e := range evs {
		set("expiry:"+e.k, WithPermissionExpiry(e.ev(), 120000))
		set("mark:"+e.k, MarkApprovePlanIfExit(e.ev()))
	}
	set("execEv", ExecutePlanEvent("t1", "sum", 600000))
	set("isExecId", []any{IsExecutePlanID("execute-plan:x"), IsExecutePlanID("x")})
	set("consts", []any{ExecutePlanIDPrefix, ExecutePlanFollowUp})
	for _, s := range []string{"a.js", "a.mjs", "a.cjs", "a.JS", "claude", "a.cmd", "x.mjs.exe"} {
		set("isScript:"+s, IsScript(s))
	}

	// generatedImages
	rw := util.NewObj("/a/b.png", "chat-asset://images/x.png", "images/1.png", "chat-asset://images/y.png", "/中 文.png", "chat-asset://images/z.png")
	for i, s := range []string{"no image here", "![a](/a/b.png)", "![a]( /a/b.png )", "![](images/1.png) and ![b](other.png)", "![c](/%E4%B8%AD%20%E6%96%87.png)", "![d](%E0%A4%A)", "![](/a/b.png)![](images/1.png)", "[x](/a/b.png)"} {
		set("rewrite:"+util.FormatNumber(float64(i)), RewriteGeneratedImageLinks(s, rw))
	}
	set("rewrite:empty", RewriteGeneratedImageLinks("![a](/a/b.png)", util.NewObj()))
	CR := filepath.Join(SB, "chat")
	set("loadAliases:missing", LoadImageAliases(CR))
	_ = os.MkdirAll(CR, 0o777)
	for _, nc := range [][2]string{{"bad", "{"}, {"arr", "[1]"}, {"null", "null"}, {"mixed", js(util.NewObj("a", "chat-asset://images/ok.png", "b", "chat-asset://images/bad/x.png", "c", float64(5), "d", "http://x", "e", "chat-asset://images/a b"))}} {
		_ = os.WriteFile(filepath.Join(CR, "image-aliases.json"), []byte(nc[1]), 0o666)
		set("loadAliases:"+nc[0], LoadImageAliases(CR))
	}
	_ = os.Remove(filepath.Join(CR, "image-aliases.json"))
	t.Setenv("GROK_HOME", "")
	os.Unsetenv("GROK_HOME")
	HOME := filepath.Join(SB, "home")
	sess := filepath.Join(HOME, ".grok", "sessions", "s1", "images")
	_ = os.MkdirAll(sess, 0o777)
	_ = os.WriteFile(filepath.Join(sess, "1.png"), []byte("PNG1"), 0o666)
	_ = os.WriteFile(filepath.Join(sess, "2.JPG"), []byte("JPG2"), 0o666)
	_ = os.WriteFile(filepath.Join(sess, "n.txt"), []byte("x"), 0o666)
	_ = os.MkdirAll(filepath.Join(sess, "d.png"), 0o777)
	_ = os.WriteFile(filepath.Join(SB, "out.png"), []byte("OUT"), 0o666)
	listImgs := func() any {
		ents, err := os.ReadDir(filepath.Join(CR, "images"))
		if err != nil {
			return nil
		}
		names := []string{}
		for _, e := range ents {
			names = append(names, uuidRe.ReplaceAllString(e.Name(), "<U>"))
		}
		sort.Strings(names)
		return strsAny(names)
	}
	mat := func(name, raw string, al *util.Obj) {
		MaterializeGeneratedImages(raw, HOME, CR, al)
		set("mat:"+name, util.NewObj("aliases", al.Clone(), "imgs", listImgs()))
	}
	pth := func(p string) string { return js(util.NewObj("path", p)) }
	al := util.NewObj()
	mat("badjson", "{", al)
	mat("nopaths", `{"a":1}`, al)
	mat("outside", pth(filepath.Join(SB, "out.png")), al)
	mat("nonimg", "["+pth(filepath.Join(sess, "n.txt"))+","+pth(filepath.Join(sess, "d.png"))+","+pth(filepath.Join(sess, "missing.png"))+"]", al)
	mat("abs", `{"content":[`+pth(filepath.Join(sess, "1.png"))+`]}`, al)
	mat("reuse", `{"output":`+pth(filepath.Join(sess, "1.png"))+`}`, al)
	mat("rel", `{"result":{"data":{"path":"s1/images/2.JPG"}}}`, al)
	mat("dotrel", `{"rawOutput":{"path":"./s1/images/1.png"}}`, al)
	deep := pth(filepath.Join(sess, "2.JPG"))
	for i := 0; i < 7; i++ {
		deep = `{"content":` + deep + `}`
	}
	mat("deep", deep, util.NewObj())
	if fb, err := os.ReadFile(filepath.Join(CR, "image-aliases.json")); err == nil {
		pv, _ := util.ParseString(string(fb))
		set("mat:persisted", pv)
	}
	set("mat:reload", LoadImageAliases(CR))

	// promptImages
	B64 := "aGVsbG8gaW1hZ2U="
	for _, bk := range []string{"claude", "codex", "dsh", "grok", "gemini", "external", "nomi"} {
		set("support:"+bk, cli.ImageSupportFor(bk))
		set("unsupported:"+bk, cli.UnsupportedImageMessage(bk))
	}
	set("noVision", cli.ModelNoVisionMessage("gpt-x"))
	raws := []any{
		util.NewObj("mime", "image/PNG ", "data", " "+B64+"\n", "width", float64(10), "height", "20", "source", "clip"),
		util.NewObj("mime", "image/jpg", "data", B64, "width", float64(-3), "height", "x", "thumb", "data:image/jpeg;base64,T"),
		util.NewObj("mime", "image/bmp", "data", B64),
		util.NewObj("mime", "image/gif", "data", "  "),
		util.NewObj("mime", "image/webp", "data", strings.Repeat("A", 600_001)),
		util.NewObj("mime", "image/webp", "data", strings.Repeat("A", 600_000), "thumb", "nodata", "source", ""),
		util.NewObj("mime", "image/webp", "data", strings.Repeat("A", 12_000_001), "thumb", "data:x"),
		util.NewObj("data", B64),
		util.NewObj("mime", "image/png", "data", B64, "width", true, "height", nil, "source", float64(7)),
	}
	set("inspect:all", short(inspectObj(cli.InspectImages(raws, 8))))
	set("inspect:max2", short(inspectObj(cli.InspectImages(raws, 2))))
	set("inspect:null", inspectObj(cli.InspectImages(nil, 8)))
	set("inspect:empty", inspectObj(cli.InspectImages([]any{}, 8)))
	set("normalize", short(imgsAny(cli.NormalizeImages(raws[:2], 1))))
	_, rej := cli.InspectImages(raws, 2)
	set("rejMsg", cli.RejectedImagesMessage(rej, 8))
	set("rejMsg:3", cli.RejectedImagesMessage(rej, 3))
	set("rejMsg:one", cli.RejectedImagesMessage([]cli.RejectedImage{{Index: 0, Reason: "empty"}}, 8))
	imgs := cli.NormalizeImages(raws, 8)
	stDir := filepath.Join(SB, "stage")
	staged, err := cli.StageImages(stDir, imgs)
	if err != nil {
		t.Fatal(err)
	}
	st := []any{}
	for _, s := range staged {
		o := short(s.Obj()).(*util.Obj)
		rel, _ := filepath.Rel(SB, s.AbsPath)
		fb, _ := os.ReadFile(s.AbsPath)
		o.Set("file", rel)
		o.Set("bytes", b64(fb))
		st = append(st, o)
	}
	set("stage", st)
	set("thumbs", short(cli.ImageThumbsForMessage(imgs)))
	for _, tx := range []string{"hi", "  ", ""} {
		q := js(tx)
		set("claudeBlocks:"+q, short(cli.ClaudeContentBlocks(tx, imgs)))
		set("claudeBlocks0:"+q, cli.ClaudeContentBlocks(tx, nil))
		set("acp:"+q, short(cli.AcpPromptParts(tx, imgs)))
		set("acp0:"+q, cli.AcpPromptParts(tx, nil))
	}
	set("codexInput", cli.CodexTurnInput("go", staged))
	set("codexArgs", strsAny(cli.CodexImageArgs(staged)))
	if a, err := cli.GrokPromptFileArgv(filepath.Join(SB, "gp"), "hi", imgs[:1]); err == nil {
		fb, _ := os.ReadFile(a[1])
		set("grokArgv", []any{a[0], a[1], string(fb)})
	}
	cli.CleanupStagedDir(stDir)
	cli.CleanupStagedDir(filepath.Join(SB, "nope"))
	_, serr := os.Stat(stDir)
	set("cleanup", serr == nil)
	set("consts:img", []any{float64(cli.ImageDataMax), float64(cli.ThumbFallbackMax)})

	// transcriptContext
	for _, c := range []string{"/Users/a/my proj", `C:\x\y`, "/中文/😀", "abc"} {
		set("projDir:"+c, cli.ClaudeProjectDirName(c))
	}
	T := fx.Get("T").(*util.Obj)
	for _, k := range T.Keys() {
		r := cli.LastTranscriptContext(T.Get(k).(string))
		if r == nil {
			set("last:"+k, nil)
		} else {
			set("last:"+k, r)
		}
	}
	CFG := filepath.Join(SB, "claude")
	CWD := filepath.Join(SB, "my proj")
	sid := "abcdef12-3456"
	pd := filepath.Join(CFG, "projects", cli.ClaudeProjectDirName(CWD))
	_ = os.MkdirAll(pd, 0o777)
	_ = os.WriteFile(filepath.Join(pd, sid+".jsonl"), []byte(T.Get("basic").(string)), 0o666)
	_ = os.MkdirAll(filepath.Join(CFG, "projects", "other"), 0o777)
	_ = os.WriteFile(filepath.Join(CFG, "projects", "other", "abcdef12-9999.jsonl"), []byte(fx.Get("rew").(string)), 0o666)
	ctx := func(r *util.Obj) any {
		if r == nil {
			return nil
		}
		return r
	}
	set("ctx:direct", ctx(cli.ClaudeTranscriptContext(CFG, CWD, sid)))
	set("ctx:scan", ctx(cli.ClaudeTranscriptContext(CFG, "/elsewhere", sid)))
	set("ctx:bad", ctx(cli.ClaudeTranscriptContext(CFG, CWD, "../x")))
	set("ctx:missing", ctx(cli.ClaudeTranscriptContext(CFG, CWD, "abcdef12-0000")))
	set("ctx:nocfg", ctx(cli.ClaudeTranscriptContext(filepath.Join(SB, "none"), CWD, sid)))
	set("ctx:cached", ctx(cli.ClaudeTranscriptContext(CFG, CWD, sid)))
	for _, u := range [][2]string{{"u1", "u1"}, {"u2", "u2"}, {"u3", "u3"}, {"none", "zz"}} {
		set("rewind:"+u[0], nullable(cli.ClaudeRewindPoint(CFG, CWD, "abcdef12-9999", u[1])))
	}
	set("rewind:bad", nullable(cli.ClaudeRewindPoint(CFG, CWD, "XYZ", "u1")))

	sbj := js(SB)
	sbj = sbj[1 : len(sbj)-1]
	norm := func(s string) string { return uuidRe.ReplaceAllString(strings.ReplaceAll(s, sbj, "<SB>"), "<U>") }
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
		if gs := norm(js(gv)); gs != want {
			t.Errorf("%s:\n go:   %s\n node: %s", name, gs, want)
		}
		n++
	}
	if n != len(got) {
		t.Errorf("Go produced %d cases, golden has %d", len(got), n)
	}
	t.Logf("compared %d harness cases (%s)", n, usage.Platform())
}

func strsAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
