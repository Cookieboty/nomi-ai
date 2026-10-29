package cli

import (
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// TestCliLeaves3Golden：record-b7-leaves.mjs 录制的 Node 行为逐条对比（失配即失败）。
func TestCliLeaves3Golden(t *testing.T) {
	p, _ := paritytest.Golden(t, "leaves.json", filepath.Join("testdata", "leaves.json"))
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
	set := func(name string, v any) { got[name] = v }

	// codexThreadIndex fixtures
	mk := func(name, ddl string, rows ...string) {
		db, err := sql.Open("sqlite", filepath.Join(SB, name))
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range append([]string{ddl}, rows...) {
			if _, err := db.Exec(q); err != nil {
				t.Fatal(err)
			}
		}
		db.Close()
	}
	mk("full.sqlite", "CREATE TABLE threads (id TEXT, source TEXT, originator TEXT, model_provider TEXT, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, model TEXT, reasoning_effort TEXT, creator_account_id TEXT, archived INTEGER, extra TEXT, rate REAL)",
		"INSERT INTO threads VALUES ('t1','cli','codex_cli_rs','openai','/w','T','n','hi','gpt-5','high','acc',0,'x',1.5)",
		"INSERT INTO threads VALUES ('t2',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL)")
	mk("part.sqlite", "CREATE TABLE threads (archived INTEGER, cwd TEXT, id TEXT, junk BLOB)", "INSERT INTO threads VALUES (1,'/a','p1',NULL)")
	mk("noid.sqlite", "CREATE TABLE threads (cwd TEXT)", "INSERT INTO threads VALUES ('/x')")
	os.WriteFile(filepath.Join(SB, "bad.sqlite"), []byte("not a database"), 0o644)
	for _, f := range []string{"full.sqlite", "part.sqlite", "noid.sqlite", "bad.sqlite", "missing.sqlite"} {
		rows := ReadCodexThreads(filepath.Join(SB, f))
		set("codexThreads:"+f, rows)
	}

	// idleReclaim（用例名驱动）
	for _, c := range g.Get("cases").([]any) {
		name := c.(*util.Obj).Get("name").(string)
		if !strings.HasPrefix(name, "resolveIdle:") {
			continue
		}
		rest := strings.TrimPrefix(name, "resolveIdle:")
		i := strings.Index(rest, ":")
		os_, es := rest[:i], rest[i+1:]
		var ov *float64
		if os_ != "undefined" {
			f := util.ToNumber(os_)
			ov = &f
		}
		var ev *string
		if es != "undefined" {
			s, _ := util.ParseString(es)
			x := s.(string)
			ev = &x
		}
		set(name, ResolveIdleReclaimMs(ov, ev))
	}
	for _, ms := range []float64{0, 1, 1000, 1001, 4000, 240000, 240003, 1e9} {
		set("sweep:"+i18n.JSNumber(ms), SweepIntervalMs(ms))
	}
	cand := func(id string, f func(*IdleCandidate)) IdleCandidate {
		c := IdleCandidate{ID: id, Resumable: true}
		f(&c)
		return c
	}
	cands := []IdleCandidate{cand("a", func(*IdleCandidate) {}), cand("b", func(c *IdleCandidate) { c.TurnActive = true }),
		cand("c", func(c *IdleCandidate) { c.PermissionPending = true }), cand("d", func(c *IdleCandidate) { c.TabBusy = true }),
		cand("e", func(c *IdleCandidate) { c.Resumable = false }), cand("f", func(c *IdleCandidate) { c.BackgroundActive = true }),
		cand("g", func(c *IdleCandidate) { c.LastActivityAt = 500 }), cand("h", func(c *IdleCandidate) { c.LastActivityAt = 1000 })}
	for _, nm := range [][2]float64{{1000, 1000}, {1500, 1000}, {2000, 0}, {2000, -1}, {100, 1000}} {
		set("pickIdle:"+i18n.JSNumber(nm[0])+":"+i18n.JSNumber(nm[1]), PickIdle(cands, nm[0], nm[1]))
	}

	// sessionModels
	smDir := func(n string, content *string) string {
		d := filepath.Join(SB, "sm-"+n)
		os.Mkdir(d, 0o755)
		if content != nil {
			os.WriteFile(filepath.Join(d, "session-models.json"), []byte(*content), 0o644)
		}
		return d
	}
	opt := func(v string, ok bool) any {
		if ok {
			return v
		}
		return nil
	}
	sp := func(s string) *string { return &s }
	loads := []struct {
		n string
		c *string
	}{{"none", nil}, {"bad", sp("{")}, {"nul", sp("null")}, {"arr", sp("[]")}, {"nosess", sp(`{"version":1}`)},
		{"mixed", sp(`{"version":1,"sessions":[["claude:a","m1"],["x"],[1,"y"],["codex:b",2],"z",["claude:a","m2"],["dsh:c","m3","extra"]]}`)}}
	for _, l := range loads {
		tb := NewSessionModelTable(smDir(l.n, l.c), nil)
		a, b, c := opt(tb.Get("claude", "a")), opt(tb.Get("codex", "b")), opt(tb.Get("dsh", "c"))
		set("sm:"+l.n+":get", []any{a, b, c})
	}
	{
		d := smDir("note", nil)
		tb := NewSessionModelTable(d, nil)
		tb.Note("claude", "  s1  ", "m1")
		tb.Note("claude", "", "m1")
		tb.Note("claude", "   ", "m1")
		tb.Note("claude", "s2", "")
		tb.Note("codex", "s2", "m2")
		tb.Note("claude", "s1", "m9")
		tb.Note("codex", "s2", "m2")
		set("sm:note:get", []any{opt(tb.Get("claude", "s1")), opt(tb.Get("claude", "  s1  ")), opt(tb.Get("codex", "s2"))})
		tb.Flush()
		raw, _ := os.ReadFile(filepath.Join(d, "session-models.json"))
		set("sm:note:file", string(raw))
	}
	{
		tb := NewSessionModelTable(smDir("cap", nil), nil)
		for i := 0; i < MaxSessions+3; i++ {
			tb.Note("claude", "s"+strconv.Itoa(i), "m")
		}
		out := []any{}
		for _, s := range []string{"s0", "s2", "s3", "s4", "s" + strconv.Itoa(MaxSessions+2)} {
			out = append(out, opt(tb.Get("claude", s)))
		}
		tb.Flush()
		set("sm:cap:get", out)
	}

	// commitMessage
	msgs := func(ms []CommitMessageMsg) []any {
		out := []any{}
		for _, m := range ms {
			out = append(out, util.NewObj("role", m.Role, "content", m.Content))
		}
		return out
	}
	set("commitPrompt:0", msgs(CommitMessagePrompt(GitCommitContext{Subjects: []string{}})))
	set("commitPrompt:2", msgs(CommitMessagePrompt(GitCommitContext{Subjects: []string{"feat: a", "fix(x): b"}, Stat: " a | 2 +-", Diff: "diff --git a b\n+x", Truncated: true})))
	raws := []string{"", "  plain  ", "a\r\nb\rc", "<think>hmm</think>\nfeat: x", "<THINK>a\nb</Think>fix: y",
		"```\nfeat: z\n```", "```text\nfeat: z\nbody\n```", "Commit message: feat: q", "COMMIT MESSAGE：x", "提交信息： 修复",
		`"quoted"`, "'`x`'", "a  \nb\t\n\n\n\nc   ", strings.Repeat("x", 4100), strings.Repeat("😀", 2001), " \u00a0nbsp\u3000 ", "commit meſſage: k",
		"```js\nconsole.log(1)\n```\ntrailing", "<think>unterminated\nfeat: k"}
	for i, r := range raws {
		set("clean:"+strconv.Itoa(i), CleanCommitMessage(r))
	}

	// contextCarry
	msg := func(role, content string, kv ...any) *util.Obj {
		o := util.NewObj("id", "x", "role", role, "content", content, "at", 0.0)
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
		return o
	}
	many := []*util.Obj{}
	for i := 0; i < 95; i++ {
		r := "user"
		if i%2 == 1 {
			r = "assistant"
		}
		many = append(many, msg(r, "m"+strconv.Itoa(i)))
	}
	big := []*util.Obj{}
	for i := 0; i < 20; i++ {
		big = append(big, msg("user", strings.Repeat(strconv.Itoa(i), 3999)))
	}
	basic := []*util.Obj{msg("user", " hi "), msg("assistant", "yo"), msg("assistant", "err", "error", true), msg("system", "sys")}
	convs := map[string][]*util.Obj{"empty": {}, "blanks": {msg("user", "  "), msg("assistant", "", "error", "boom")},
		"basic": basic, "long": {msg("user", strings.Repeat("a", 4001)), msg("assistant", strings.Repeat("😀", 2001))},
		"many": many, "big": big, "nocontent": {util.NewObj("id", "y", "role", "user", "at", 0.0)}}
	carry := func(c *CarriedContext) any {
		if c == nil {
			return nil
		}
		return util.NewObj("text", c.Text, "messages", float64(c.Messages))
	}
	for n, ms := range convs {
		set("carry:"+n, carry(BuildCarriedContext(ms, "/old/dir")))
	}
	for _, b := range []string{"claude", "gemini", "codex", "dsh", "grok", "external", "nomi"} {
		for _, p := range []string{"win32", "darwin", "linux"} {
			set("budget:"+b+":"+p, float64(CarriedBudget(b, p)))
		}
	}
	sample := BuildCarriedContext(append(append([]*util.Obj{}, basic...), many[:6]...), "/d").Text
	fit := func(s string, ok bool) any { return opt(s, ok) }
	for _, max := range []int{0, 50, 120, 200, 250, 300, 400, 10000} {
		set("fit:"+strconv.Itoa(max), fit(FitCarried(sample, max)))
	}
	for _, tx := range []string{"short", strings.Repeat("x", 30), "<previous_conversation>\n</previous_conversation>",
		"h<previous_conversation>\nUser: a\nUser: b\nAssistant: c\nnot\n</previous_conversation>t",
		"\n</previous_conversation><previous_conversation>\nUser: z"} {
		js := util.Stringify(tx)
		if len(js) > 40 {
			js = js[:40]
		}
		for _, max := range []int{3, 20, 60} {
			set("fitx:"+js+":"+strconv.Itoa(max), fit(FitCarried(tx, max)))
		}
	}
	for _, c := range []struct {
		n string
		c *string
	}{{"null", nil}, {"undefined", nil}, {"", sp("")}, {"ctx", sp("ctx")}} {
		set("with:"+c.n, WithCarriedContext(c.c, "p"))
	}
	set("strip", StripCarriedContext(WithCarriedContext(&sample, "real prompt")))

	// historyTranscript
	tx := map[string]string{
		"claude": `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2024-01-01T00:00:00Z","uuid":"u1"}` + "\n" + `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"timestamp":"2024-01-01T00:00:01Z","uuid":"a1"}`,
		"codex":  `{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}}`,
		"dsh":    `{"role":"user","content":"d"}`, "gemini": `{"messages":[{"type":"user","content":"g"}]}`, "grok": `{"role":"user","content":"k"}`,
	}
	for b, s := range tx {
		set("transcript:"+b, ParseTranscript(b, s, 5))
		ti := TitleFromMessages(ParseTranscript(b, s, 0))
		if ti == nil {
			set("title:"+b, nil)
		} else {
			set("title:"+b, *ti)
		}
	}
	set("historyMax", float64(HistoryMaxMessages))

	n := 0
	for _, c := range g.Get("cases").([]any) {
		co := c.(*util.Obj)
		name := co.Get("name").(string)
		gv, ok := got[name]
		if !ok {
			t.Errorf("%s: no Go case", name)
			continue
		}
		out := co.Get("out").(*util.Obj)
		var want string
		if out.Get("undef") == true {
			want = "undefined"
		} else if e, ok := out.Lookup("err"); ok {
			want = "err:" + util.Str(e)
		} else {
			want = util.Stringify(out.Get("v"))
		}
		gs := util.Stringify(normLeaf(gv, SB))
		if gs != want {
			t.Errorf("%s:\n go:   %s\n node: %s", name, gs, want)
		}
		n++
	}
	if n != len(got) {
		t.Errorf("Go produced %d cases, golden has %d", len(got), n)
	}
	t.Logf("compared %d leaf cases (%s)", n, usage.Platform())
	_ = math.NaN
}

func normLeaf(v any, sb string) any {
	switch x := v.(type) {
	case []*util.Obj:
		out := make([]any, len(x))
		for i, o := range x {
			out[i] = o
		}
		return out
	case []string:
		out := make([]any, len(x))
		for i, o := range x {
			out[i] = o
		}
		return out
	case string:
		return strings.ReplaceAll(x, sb, "<SB>")
	}
	return v
}
