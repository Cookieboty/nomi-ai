package delegate

// golden：scripts/parity/record-b7s2-delegate.mjs（fns / worktree / service / tools）

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

const sbTok = "@@SB@@"

func loadGolden(t *testing.T) *util.Obj {
	t.Helper()
	p, _ := paritytest.Golden(t, "b7s2-delegate.json", filepath.Join("testdata", "b7s2-delegate.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v.(*util.Obj)
}

func undef(v any) any {
	if v == "@@undef@@" {
		return util.Undefined
	}
	return v
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func strs(v any) []string {
	out := []string{}
	for _, x := range arr(v) {
		out = append(out, util.Str(x))
	}
	return out
}

func jsonEq(t *testing.T, label string, want, got any) {
	t.Helper()
	w, g := util.Stringify(want), util.Stringify(got)
	if w != g {
		t.Errorf("%s:\n want %s\n  got %s", label, w, g)
	}
}

func optS(o *util.Obj, k string) string { return util.Str(o.Get(k)) }

func TestDelegateParityFns(t *testing.T) {
	g := loadGolden(t)
	for i, fv := range arr(g.Get("fns")) {
		f := fv.(*util.Obj)
		args := arr(f.Get("args"))
		var got any
		switch fn := util.Str(f.Get("fn")); fn {
		case "sanitize":
			got = SanitizeDelegateSettings(undef(args[0]))
		case "merge":
			got = MergeAgentProfiles(undef(args[0]))
		case "overrides":
			in := args[0].(*util.Obj)
			got = ResolveDelegateOverrides(OverridesInput{Model: in.Get("model"), ReasoningEffort: in.Get("reasoningEffort"), Profile: in.Get("profile"), Settings: SanitizeDelegateSettings(args[1])})
		case "resolveCli":
			got = nilIfEmpty(ResolveDelegateCli(args[0]))
		case "pick":
			in := args[0].(*util.Obj)
			d, _ := in.Get("defaults").(*util.Obj)
			p := PickDelegateCli(PickInput{Pinned: optS(in, "pinned"), Requested: optS(in, "requested"), Kind: optS(in, "kind"), Defaults: d, Installed: strs(in.Get("installed"))})
			if p != nil {
				got = util.NewObj("cli", p.Cli, "by", p.By)
			}
		case "childMode":
			got = ChildPermissionMode(util.Str(args[0]), util.Str(args[1]))
		case "prompt":
			in := args[0].(*util.Obj)
			got = BuildDelegatePrompt(DelegateBrief{Goal: optS(in, "goal"), Context: optS(in, "context"), DoneWhen: optS(in, "doneWhen"), OutOfScope: optS(in, "outOfScope")})
		case "promptText":
			got = BuildDelegatePrompt(DelegateBrief{Goal: "g", DoneWhen: "d"})
		case "report":
			if r := ParseDelegateReport(util.Str(args[0])); r != nil {
				got = r
			}
		case "porcelain":
			got = ParsePorcelain(util.Str(args[0]))
		case "tail":
			n, _ := args[1].(float64)
			got = TailText(util.Str(args[0]), int(n))
		case "radix36":
			got = NumberToString36(args[0].(float64))
		default:
			t.Fatalf("unknown fn %s", fn)
		}
		want := undef(f.Get("out"))
		if want == util.Undefined {
			want = nil
		}
		jsonEq(t, util.Stringify(f.Get("fn"))+"#"+util.Stringify(float64(i)), want, got)
	}
}

func shGit(t *testing.T, dir string, a ...string) string {
	t.Helper()
	c := exec.Command("git", a...)
	c.Dir = dir
	c.Env = append(stripGitEnv(), "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-01-01T00:00:00Z")
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", a, err, out)
	}
	return string(out)
}

func mkrepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	shGit(t, dir, "init", "-q", "-b", "main")
	shGit(t, dir, "config", "user.email", "t@t")
	shGit(t, dir, "config", "user.name", "t")
	shGit(t, dir, "config", "commit.gpgsign", "false")
	writeF(t, filepath.Join(dir, "a.txt"), "a\n")
	writeF(t, filepath.Join(dir, "src/b.txt"), "b\n")
	shGit(t, dir, "add", "-A")
	shGit(t, dir, "commit", "-q", "-m", "init")
}

func writeF(t *testing.T, p, v string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(v), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readF(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sandbox(t *testing.T) string {
	if _, err := exec.LookPath("git"); err != nil {
		paritytest.SkipOrFail(t, "git missing")
	}
	sb, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return sb
}

// tokv：沙箱路径 → @@SB@@（同 recorder 的 tok / untok）
func tokv(sb string, v any) any {
	s := util.Stringify(v)
	for _, f := range []string{strings.ReplaceAll(sb, `\`, `\\\\`), strings.ReplaceAll(sb, `\`, `\\`), sb, strings.ReplaceAll(sb, `\`, `/`)} {
		s = strings.ReplaceAll(s, f, sbTok)
	}
	if filepath.Separator == '\\' {
		s = sbAlias(sb).ReplaceAllString(s, sbTok)
	}
	r, err := util.ParseString(s)
	if err != nil {
		panic(err)
	}
	return r
}

// sbAlias：按沙箱末两级目录匹配任何别名（Windows 8.3 短名 vs git 输出的长名），同 recorder 的 tokAlias
func sbAlias(sb string) *regexp.Regexp {
	parts := strings.FieldsFunc(sb, func(r rune) bool { return r == '\\' || r == '/' })
	a, b := regexp.QuoteMeta(parts[len(parts)-2]), regexp.QuoteMeta(parts[len(parts)-1])
	return regexp.MustCompile(`(?:[A-Za-z]:|/)[^"\s:]*?` + a + `(?:[\\/])+` + b)
}

func isoObj(h *IsolationHandle) any {
	if h == nil {
		return nil
	}
	return h.Obj()
}

func applyObj(r ApplyResult) *util.Obj {
	return util.NewObj("applied", r.Applied, "skipped", r.Skipped, "conflicted", r.Conflicted, "denied", r.Denied)
}

func TestDelegateParityWorktree(t *testing.T) {
	g := loadGolden(t)
	sb := sandbox(t)
	repo := filepath.Join(sb, "wt/repo")
	mkrepo(t, repo)
	plain := filepath.Join(sb, "wt/plain")
	empty := filepath.Join(sb, "wt/empty")
	_ = os.MkdirAll(plain, 0o755)
	_ = os.MkdirAll(empty, 0o755)
	shGit(t, empty, "init", "-q")
	var got []any
	push := func(kv ...any) { got = append(got, tokv(sb, util.NewObj(kv...))) }
	push("op", "gitRoot", "cwd", repo, "out", nilIfEmpty(ResolveGitRoot(filepath.Join(repo, "src"))))
	push("op", "gitRoot", "cwd", plain, "out", nilIfEmpty(ResolveGitRoot(plain)))
	h1, _ := PrepareIsolation(plain, "k1")
	push("op", "prepare", "cwd", plain, "out", isoObj(h1))
	h2, _ := PrepareIsolation(empty, "k/2 x")
	push("op", "prepare", "cwd", empty, "out", isoObj(h2))
	h, err := PrepareIsolation(repo, "del-abc-xyz")
	if err != nil {
		t.Fatal(err)
	}
	push("op", "prepare", "cwd", repo, "out", isoObj(h))
	push("op", "exclude", "out", readF(t, filepath.Join(repo, ".git/info/exclude")))
	push("op", "changedWt", "out", GitChanged(h.Cwd))
	writeF(t, filepath.Join(h.Cwd, "a.txt"), "A2\n")
	writeF(t, filepath.Join(h.Cwd, "new.txt"), "N\n")
	writeF(t, filepath.Join(h.Cwd, "deny/x.txt"), "D\n")
	writeF(t, filepath.Join(h.Cwd, "src/b.txt"), "B2\n")
	writeF(t, filepath.Join(repo, "src/b.txt"), "user edit\n")
	ch := GitChanged(h.Cwd)
	push("op", "changedWt", "out", ch)
	push("op", "changedMain", "out", GitChanged(filepath.Join(repo, "src")))
	var pl any
	if c := GitChanged(plain); c != nil {
		pl = c
	}
	push("op", "changedPlain", "out", pl)
	sep := string(filepath.Separator)
	ar := ApplyWorktreeToMain(h, append(append([]string{}, ch...), "../evil", "", "gone.txt"), func(d string) bool { return !strings.Contains(d, sep+"deny"+sep) })
	_, denyErr := os.Stat(filepath.Join(repo, "deny/x.txt"))
	push("op", "apply", "out", applyObj(ar), "main", util.NewObj("a", readF(t, filepath.Join(repo, "a.txt")), "b", readF(t, filepath.Join(repo, "src/b.txt")), "n", readF(t, filepath.Join(repo, "new.txt")), "deny", denyErr == nil))
	ReleaseIsolation(h, nil)
	_, exErr := os.Stat(h.Cwd)
	n := 0
	for _, l := range strings.Split(shGit(t, repo, "worktree", "list", "--porcelain"), "\n") {
		if strings.HasPrefix(l, "worktree ") {
			n++
		}
	}
	push("op", "release", "exists", exErr == nil, "list", float64(n))
	h3, _ := PrepareIsolation(repo, "del-abc-xyz")
	_ = os.RemoveAll(h3.Cwd)
	logs := []string{}
	ReleaseIsolation(h3, func(m string) { logs = append(logs, strings.SplitN(m, ":", 2)[0]) })
	push("op", "releaseMissing", "logs", logs)
	want := arr(g.Get("worktree"))
	if len(want) != len(got) {
		t.Fatalf("worktree ops: want %d got %d", len(want), len(got))
	}
	for i := range want {
		jsonEq(t, "worktree#"+util.Stringify(float64(i)), want[i], got[i])
	}
}

func TestDelegateParityTools(t *testing.T) {
	g := loadGolden(t)
	s := New(Deps{Root: t.TempDir(), Harness: &fakeHarness{sc: util.NewObj()}, Desktop: &fakeDesktop{}, Events: nil})
	var got []any
	for _, d := range s.Tools() {
		got = append(got, util.NewObj("name", d.Name, "description", d.Description, "schema", d.Input))
	}
	jsonEq(t, "tools", g.Get("tools"), got)
}

// ---------- service fakes（同 recorder makeEnv） ----------

type envLog struct {
	mu                                    sync.Mutex
	harness, sent, desktop, audit, events []any
}

func (l *envLog) add(dst *[]any, v any) { l.mu.Lock(); *dst = append(*dst, v); l.mu.Unlock() }

type fakeHarness struct {
	sc       *util.Obj
	base     string
	log      *envLog
	mu       sync.Mutex
	tabN     int
	tabs     []any
	sends    []any
	pending  []chan struct{}
	pendMu   sync.Mutex
	abort    func()
	cancelCh chan struct{}
}

func (h *fakeHarness) sub(s string) string { return strings.ReplaceAll(s, sbTok, h.base) }

func (h *fakeHarness) State() *util.Obj {
	bins := util.NewObj()
	for _, c := range strs(h.sc.Get("installed")) {
		bins.Set(c, "/bin/"+c)
	}
	return util.NewObj("bins", bins)
}

func (h *fakeHarness) ListTabs() *util.Obj {
	h.mu.Lock()
	defer h.mu.Unlock()
	td := h.sc.Get("tabDefault")
	if td == nil {
		td = "acceptEdits"
	}
	return util.NewObj("tabs", append([]any{}, h.tabs...), "defaultPermissionMode", td)
}

func (h *fakeHarness) RecentCwds() []string {
	out := []string{}
	for _, c := range strs(h.sc.Get("recent")) {
		out = append(out, h.sub(c))
	}
	return out
}

func (h *fakeHarness) AutoApproveEnabled() bool { return util.Truthy(h.sc.Get("autoApprove")) }

func (h *fakeHarness) CreateTab(o *util.Obj) (*util.Obj, error) {
	h.log.add(&h.log.harness, []any{"createTab", o.Clone()})
	if util.Truthy(h.sc.Get("createFail")) {
		return nil, errors.New("create failed")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tabN++
	id := "tab-" + util.Stringify(float64(h.tabN))
	del := util.NewObj("by", "nomi", "goal", o.Get("delegation").(*util.Obj).Get("goal"))
	if a := h.sc.Get("tabApprovals"); a != nil {
		del.Set("approvals", a)
	}
	h.tabs = append(h.tabs, util.NewObj("id", id, "delegation", del))
	return util.NewObj("id", id), nil
}

func (h *fakeHarness) SendTab(id, prompt string) (*util.Obj, error) {
	h.log.add(&h.log.sent, []any{id, prompt})
	h.mu.Lock()
	s := util.NewObj("text", "")
	if len(h.sends) > 0 {
		s = h.sends[0].(*util.Obj)
		h.sends = h.sends[1:]
	}
	h.mu.Unlock()
	if util.Truthy(s.Get("hold")) {
		ch := make(chan struct{})
		h.pendMu.Lock()
		h.pending = append(h.pending, ch)
		h.pendMu.Unlock()
		<-ch
	}
	if util.Truthy(s.Get("abort")) && h.abort != nil {
		h.abort()
		select {
		case <-h.cancelCh:
		case <-time.After(5 * time.Second):
		}
	}
	if st, ok := s.Lookup("stop"); ok {
		return nil, &harness.StoppedError{Msg: "stopped", PartialText: util.Str(st)}
	}
	if e := s.Get("error"); util.Truthy(e) {
		return nil, errors.New(util.Str(e))
	}
	if w, ok := s.Get("write").(*util.Obj); ok {
		dir := sbTok
		if d := s.Get("dir"); d != nil {
			dir = util.Str(d)
		}
		for _, k := range w.Keys() {
			p := filepath.Join(h.sub(dir), k)
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte(util.Str(w.Get(k))), 0o644)
		}
	}
	r := util.NewObj("text", s.Get("text"))
	if u := s.Get("usage"); u != nil {
		r.Set("usage", u)
	}
	return r, nil
}

func (h *fakeHarness) release() {
	h.pendMu.Lock()
	p := h.pending
	h.pending = nil
	h.pendMu.Unlock()
	// Node 依次 resolve，微任务逐个跑完 finalize；Go 逐个放行并等该任务发出 completed 事件
	for _, ch := range p {
		n := h.log.eventCount()
		close(ch)
		for i := 0; i < 1000 && h.log.eventCount() == n; i++ {
			time.Sleep(2 * time.Millisecond)
		}
	}
}

func (h *fakeHarness) CancelTab(id string) {
	h.log.add(&h.log.harness, []any{"cancelTab", id})
	if h.cancelCh != nil {
		select {
		case h.cancelCh <- struct{}{}:
		default:
		}
	}
}

func (h *fakeHarness) CloseTab(id string) error {
	h.log.add(&h.log.harness, []any{"closeTab", id})
	if util.Truthy(h.sc.Get("closeFail")) {
		return errors.New("x")
	}
	return nil
}

type fakeDesktop struct {
	sc        *util.Obj
	base      string
	log       *envLog
	mu        sync.Mutex
	decisions []string
}

func (d *fakeDesktop) sub(s string) string { return strings.ReplaceAll(s, sbTok, d.base) }

func (d *fakeDesktop) WorkspaceOf(cwd any) string {
	d.log.add(&d.log.desktop, []any{"workspaceOf", cwd})
	if ws := d.sc.Get("ws"); ws != nil {
		return d.sub(util.Str(ws))
	}
	return ""
}

func (d *fakeDesktop) Guard(p any, need string, allowMissing bool) desktop.GuardResult {
	r := pth.Resolve(jsString(p))
	ok := false
	for _, g := range strs(d.sc.Get("granted")) {
		g = pth.Resolve(d.sub(g))
		if r == g || strings.HasPrefix(r, g+string(filepath.Separator)) {
			ok = true
		}
	}
	d.log.add(&d.log.desktop, []any{"guard", p, need, allowMissing, ok})
	if ok {
		return desktop.GuardResult{OK: true, Real: r}
	}
	return desktop.GuardResult{Code: "not_granted", Message: "未授权：" + r}
}

func (d *fakeDesktop) GuardIn(ws string, p any, need string, allowMissing bool) desktop.GuardResult {
	r := pth.Resolve(ws, jsString(p))
	ok := r == ws || strings.HasPrefix(r, ws+string(filepath.Separator))
	d.log.add(&d.log.desktop, []any{"guardIn", ws, p, need, ok})
	if ok {
		return desktop.GuardResult{OK: true, Real: r}
	}
	return desktop.GuardResult{Code: "outside", Message: "不在工作区：" + r}
}

func authObj(i desktop.AuthorizeInput) *util.Obj {
	o := util.NewObj("tool", i.Tool, "danger", i.Danger, "summary", i.Summary, "args", i.Args)
	if i.Preview != nil {
		o.Set("preview", *i.Preview)
	}
	o.Set("signal", i.Signal != nil)
	return o
}

func (d *fakeDesktop) decide() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.decisions) == 0 {
		return "allowed"
	}
	x := d.decisions[0]
	d.decisions = d.decisions[1:]
	return x
}

func (d *fakeDesktop) Authorize(i desktop.AuthorizeInput) desktop.Decision {
	d.log.add(&d.log.desktop, []any{"authorize", authObj(i)})
	return d.decide()
}

func (d *fakeDesktop) AuthorizeIn(i desktop.AuthorizeInput) desktop.Decision {
	d.log.add(&d.log.desktop, []any{"authorizeIn", authObj(i)})
	return d.decide()
}

func (d *fakeDesktop) PermissionMode() string {
	if m := d.sc.Get("mode"); m != nil {
		return util.Str(m)
	}
	return "acceptEdits"
}

func (d *fakeDesktop) MarkRead(sig context.Context) {
	d.log.add(&d.log.desktop, []any{"markRead", sig != nil})
}

func (d *fakeDesktop) CheckSend(p *desktop.Provider, sig context.Context, what string) string {
	d.log.add(&d.log.desktop, []any{"checkSend", p.ID, what})
	if util.Truthy(d.sc.Get("blockSend")) {
		return "local_only"
	}
	return ""
}

func (d *fakeDesktop) ReceiversFor(p *tools.ToolCallProvider, roles []string) []*desktop.Provider {
	var id any
	if p != nil {
		id = p.ID
	}
	d.log.add(&d.log.desktop, []any{"receiversFor", id, roles})
	out := []*desktop.Provider{}
	for _, r := range strs(d.sc.Get("receivers")) {
		out = append(out, &desktop.Provider{ID: r, Name: r})
	}
	return out
}

func (d *fakeDesktop) AuditAppend(e desktop.AuditEntry, raw any) {
	o := util.NewObj("tool", e.Tool, "args", raw, "decision", e.Decision, "result", e.Result)
	if e.Ms != nil {
		o.Set("ms", float64(*e.Ms))
	}
	if e.Source != "" {
		o.Set("source", e.Source)
	}
	d.log.add(&d.log.audit, o)
}

type fakeGateway struct{ g *util.Obj }

func (f fakeGateway) Defaults(cli string) *util.Obj {
	return util.NewObj("source", f.g.Get("source"), "model", f.g.Get("model"))
}

func (f fakeGateway) Models() []*util.Obj {
	out := []*util.Obj{}
	for _, r := range arr(f.g.Get("models")) {
		out = append(out, util.NewObj("ref", r))
	}
	return out
}

type fakeEvents struct{ log *envLog }

func (e fakeEvents) Publish(ev string, p any) { e.log.add(&e.log.events, []any{ev, p}) }

func subDeep(base string, v any) any {
	s := strings.ReplaceAll(util.Stringify(v), sbTok, strings.ReplaceAll(base, `\`, `\\`))
	r, _ := util.ParseString(s)
	return r
}

func TestDelegateParityService(t *testing.T) {
	g := loadGolden(t)
	for _, sv := range arr(g.Get("service")) {
		sc := sv.(*util.Obj)
		name := util.Str(sc.Get("name"))
		t.Run(name, func(t *testing.T) { runServiceScenario(t, sc) })
	}
}

func runServiceScenario(t *testing.T, rec *util.Obj) {
	sc := rec.Get("sc").(*util.Obj)
	sb := sandbox(t)
	B := sb
	_ = os.MkdirAll(filepath.Join(B, "plain/sub"), 0o755)
	_ = os.MkdirAll(filepath.Join(B, "state"), 0o755)
	if r := sc.Get("repo"); r != nil {
		mkrepo(t, filepath.Join(B, util.Str(r)))
	}
	if sf, ok := sc.Lookup("settingsFile"); ok {
		s, isStr := sf.(string)
		if !isStr {
			s = util.Stringify(sf)
		}
		writeF(t, filepath.Join(B, "state/settings.json"), s)
	}
	if tf := sc.Get("tasksFile"); tf != nil {
		writeF(t, filepath.Join(B, "state/tasks.json"), util.Stringify(subDeep(B, tf)))
	}
	var nmu sync.Mutex
	now := 1767000000000.0
	rnd := []float64{0.5}
	if r := sc.Get("rnd"); r != nil {
		rnd = nil
		for _, x := range arr(r) {
			rnd = append(rnd, x.(float64))
		}
	}
	ri := 0
	log := &envLog{}
	h := &fakeHarness{sc: sc, base: B, log: log, cancelCh: make(chan struct{}, 4)}
	for _, tb := range arr(sc.Get("tabs")) {
		h.tabs = append(h.tabs, tb.(*util.Obj).Clone())
	}
	h.sends = append(h.sends, arr(sc.Get("sends"))...)
	dk := &fakeDesktop{sc: sc, base: B, log: log, decisions: strs(sc.Get("decisions"))}
	deps := Deps{Root: filepath.Join(B, "state"), Harness: h, Desktop: dk, Events: fakeEvents{log},
		Now:    func() float64 { nmu.Lock(); defer nmu.Unlock(); return now },
		Random: func() float64 { nmu.Lock(); defer nmu.Unlock(); x := rnd[ri%len(rnd)]; ri++; return x }}
	if gw, ok := sc.Get("gateway").(*util.Obj); ok {
		deps.Gateway = fakeGateway{gw}
	}
	svc := New(deps)
	defs := map[string]tools.Definition{}
	for _, d := range svc.Tools() {
		defs[d.Name] = d
	}
	var out []any
	for _, stv := range arr(sc.Get("steps")) {
		st := stv.(*util.Obj)
		var r any
		var err error
		switch util.Str(st.Get("op")) {
		case "tool":
			c := st.Get("ctx").(*util.Obj)
			ec := tools.ExecContext{ToolCallID: optS(c, "toolCallId"), ReqID: optS(c, "reqId"), CallerTabID: optS(c, "callerTabId"), ConversationID: optS(c, "conversationId"), Cwd: strings.ReplaceAll(optS(c, "cwd"), sbTok, B)}
			if p, ok := c.Get("provider").(*util.Obj); ok {
				ec.Provider = &tools.ToolCallProvider{ID: optS(p, "id"), BaseURL: optS(p, "baseURL")}
			}
			var ctx context.Context
			if sg := c.Get("signal"); sg != nil {
				cctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if sg == "aborted" {
					cancel()
				}
				ctx = cctx
				h.abort = cancel
			}
			before := len(log.sentSnapshot())
			r, err = defs[util.Str(st.Get("tool"))].Execute(ctx, subDeep(B, st.Get("raw")), ec)
			// 后台任务：Node 在返回前已同步调用 sendTab；Go goroutine 等它进入 SendTab
			if o, ok := r.(*util.Obj); ok && util.Str(st.Get("tool")) == "delegate_to_cli" {
				if d, ok := o.Get("data").(*util.Obj); ok && d.Get("status") == "running" {
					for i := 0; i < 500 && len(log.sentSnapshot()) <= before; i++ {
						time.Sleep(2 * time.Millisecond)
					}
				}
			}
		case "pin":
			var s string
			s, err = svc.Pin(st.Get("name"), st.Get("turn"))
			r = nilIfEmpty(s)
		case "peek":
			r = nilIfEmpty(svc.PeekPin(optS(st, "turn")))
		case "now":
			nmu.Lock()
			now = st.Get("v").(float64)
			nmu.Unlock()
		case "statusOf":
			if o := svc.StatusOf(optS(st, "id")); o != nil {
				r = o
			}
		case "settings":
			r = svc.Settings()
		case "setSettings":
			var o *util.Obj
			o, err = svc.SetSettings(st.Get("raw"))
			if o != nil {
				r = o
			}
		case "settingsFileOut":
			r = readF(t, filepath.Join(B, "state/settings.json"))
		case "release":
			h.release()
		case "wait":
			svc.WaitIdle()
		case "tasks":
			if b, e := os.ReadFile(filepath.Join(B, "state/tasks.json")); e == nil {
				r = string(b)
			}
		case "file":
			// 同 Node readFileSync：缺失时记 err 而非中止，便于看到后续 out 的 diff
			if b, e := os.ReadFile(filepath.Join(B, optS(st, "p"))); e == nil {
				r = string(b)
			} else {
				err = e
			}
		case "takeOver":
			h.mu.Lock()
			for _, tb := range h.tabs {
				if o := tb.(*util.Obj); o.Get("id") == st.Get("id") {
					if dg, ok := o.Get("delegation").(*util.Obj); ok && dg != nil {
						dg.Set("takenOver", true)
					}
				}
			}
			h.mu.Unlock()
		case "closeTabs":
			h.mu.Lock()
			h.tabs = nil
			h.mu.Unlock()
		}
		if err != nil {
			out = append(out, util.NewObj("err", tokv(B, err.Error())))
		} else {
			out = append(out, util.NewObj("ok", tokv(B, r)))
		}
	}
	svc.WaitIdle()
	want := arr(rec.Get("out"))
	for i := range want {
		w := want[i].(*util.Obj)
		var gv any
		if i < len(out) {
			gv = out[i]
		}
		jsonEq(t, "out#"+util.Stringify(float64(i)), w, gv)
	}
	wl := rec.Get("log").(*util.Obj)
	gl := tokv(B, util.NewObj("harness", nz(log.harness), "sent", nz(log.sent), "desktop", nz(log.desktop), "audit", nz(log.audit), "events", nz(log.events))).(*util.Obj)
	for _, k := range []string{"harness", "sent", "desktop", "audit", "events"} {
		jsonEq(t, "log."+k, wl.Get(k), gl.Get(k))
	}
}

func nz(v []any) []any {
	if v == nil {
		return []any{}
	}
	return v
}

func (l *envLog) sentSnapshot() []any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]any{}, l.sent...)
}

func arr(v any) []any { a, _ := v.([]any); return a }

func (l *envLog) eventCount() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.events) }
