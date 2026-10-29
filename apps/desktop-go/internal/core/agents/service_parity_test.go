package agents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type agentsGolden struct {
	Pure struct {
		Classify struct {
			In []struct {
				Pid       float64
				Name, Cmd string
			} `json:"in"`
			Self float64 `json:"self"`
			Out  any     `json:"out"`
		} `json:"classify"`
		ParsePs struct {
			In  string `json:"in"`
			Out any    `json:"out"`
		} `json:"parsePs"`
		ParseWinJson []struct {
			In  string `json:"in"`
			Out any    `json:"out"`
		} `json:"parseWinJson"`
		ParseProcLocks struct {
			In  string    `json:"in"`
			Out []float64 `json:"out"`
		} `json:"parseProcLocks"`
		Sanitize []struct {
			In  json.RawMessage `json:"in"`
			Out any             `json:"out"`
		} `json:"sanitize"`
		WithCost []struct {
			Text string  `json:"text"`
			Cost *string `json:"cost"`
			Out  string  `json:"out"`
		} `json:"withCost"`
		TabView []struct {
			In  json.RawMessage `json:"in"`
			Out any             `json:"out"`
		} `json:"tabView"`
	} `json:"pure"`
	Scenario struct {
		Now0    float64 `json:"now0"`
		Fixture []struct {
			Rel     string            `json:"rel"`
			Age     float64           `json:"age"`
			Raw     *string           `json:"raw"`
			Content []json.RawMessage `json:"content"`
		} `json:"fixture"`
		AppendClaude json.RawMessage `json:"appendClaude"`
		AppendTool   json.RawMessage `json:"appendTool"`
		AppendDone   json.RawMessage `json:"appendDone"`
		Steps        []any           `json:"steps"`
	} `json:"scenario"`
}

// norm 经 JSON 往返成 encoding/json 的通用值，便于 DeepEqual
func gnorm(t *testing.T, v any) any {
	t.Helper()
	var s string
	switch x := v.(type) {
	case string:
		s = x
	default:
		if o, ok := v.(*util.Obj); ok || isUtil(v) {
			_ = o
			s = util.Stringify(v)
		} else {
			b, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			s = string(b)
		}
	}
	var out any
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		t.Fatalf("%v: %s", err, s)
	}
	return out
}

func isUtil(v any) bool {
	switch v.(type) {
	case []any, map[string]any, nil, bool, float64:
		return true
	}
	return false
}

func procsJSON(ps []AgentProc) []any {
	out := []any{}
	for _, p := range ps {
		o := util.NewObj("pid", p.Pid, "kind", p.Kind)
		if p.Cwd != "" {
			o.Set("cwd", p.Cwd)
		}
		out = append(out, o)
	}
	return out
}

func rawJSON(ps []RawProc) []any {
	out := []any{}
	for _, p := range ps {
		out = append(out, util.NewObj("pid", p.Pid, "name", p.Name, "cmd", p.Cmd))
	}
	return out
}

func eq(t *testing.T, what string, got, want any) {
	t.Helper()
	g, w := gnorm(t, got), gnorm(t, want)
	if !reflect.DeepEqual(g, w) {
		gb, _ := json.MarshalIndent(g, "", " ")
		wb, _ := json.MarshalIndent(w, "", " ")
		if d := os.Getenv("AGENTS_DIFF"); d != "" {
			_ = os.WriteFile(filepath.Join(d, what+".got"), gb, 0o666)
			_ = os.WriteFile(filepath.Join(d, what+".want"), wb, 0o666)
			t.Errorf("%s mismatch", what)
			return
		}
		t.Errorf("%s mismatch\n got: %s\nwant: %s", what, gb, wb)
	}
}

func parseRaw(t *testing.T, b []byte) any {
	v, err := util.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func loadAgentsGolden(t *testing.T) agentsGolden {
	p, _ := paritytest.Golden(t, "b7s2-agents.json", "testdata/b7s2-agents.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g agentsGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestAgentsPureGolden(t *testing.T) {
	g := loadAgentsGolden(t).Pure
	in := []RawProc{}
	for _, r := range g.Classify.In {
		in = append(in, RawProc{r.Pid, r.Name, r.Cmd})
	}
	eq(t, "classify", procsJSON(Classify(in, g.Classify.Self)), g.Classify.Out)
	eq(t, "parsePs", rawJSON(ParsePs(g.ParsePs.In)), g.ParsePs.Out)
	for i, c := range g.ParseWinJson {
		eq(t, "parseWinJson#"+util.JSString(float64(i)), rawJSON(ParseWinJson(c.In)), c.Out)
	}
	locks := []float64{}
	for k := range ParseProcLocks(g.ParseProcLocks.In) {
		locks = append(locks, k)
	}
	sort.Float64s(locks)
	want := append([]float64(nil), g.ParseProcLocks.Out...)
	sort.Float64s(want)
	if !reflect.DeepEqual(locks, want) {
		t.Errorf("parseProcLocks %v want %v", locks, want)
	}
	for i, c := range g.Sanitize {
		var raw any
		if string(c.In) != `"__undef"` {
			raw = parseRaw(t, c.In)
		}
		eq(t, "sanitize#"+util.JSString(float64(i)), SanitizeAgentWatch(raw, DefaultAgentWatch()).Obj(), c.Out)
	}
	for i, c := range g.WithCost {
		cost := ""
		if c.Cost != nil {
			cost = *c.Cost
		}
		if got := WithCost(c.Text, cost); got != c.Out {
			t.Errorf("withCost#%d %q want %q", i, got, c.Out)
		}
	}
	for i, c := range g.TabView {
		eq(t, "tabView#"+util.JSString(float64(i)), TabView(util.AsObj(parseRaw(t, c.In))), c.Out)
	}
}

type capLog struct{ log *[]any }

func (l capLog) Info(m string, d ...any) { *l.log = append(*l.log, []any{"info", m, first(d)}) }
func (l capLog) Warn(m string, d ...any) { *l.log = append(*l.log, []any{"warn", m, first(d)}) }
func first(d []any) any {
	if len(d) == 0 {
		return nil
	}
	return d[0]
}

type capEvents struct{ log *[]any }

func (e capEvents) Publish(ev string, p any) { *e.log = append(*e.log, []any{"event", ev, p}) }

func sortedNotice(n Notice) *util.Obj {
	o := n.Obj()
	ks := o.Keys()
	sort.Strings(ks)
	out := util.NewObj()
	for _, k := range ks {
		out.Set(k, o.Get(k))
	}
	return out
}

func TestAgentsServiceGolden(t *testing.T) {
	g := loadAgentsGolden(t).Scenario
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	H := tmp
	write := func(rel string, raw *string, content []json.RawMessage, age, now float64) {
		p := filepath.Join(H, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(p), 0o777)
		var b string
		if raw != nil {
			b = *raw
		} else {
			ls := []string{}
			for _, c := range content {
				ls = append(ls, util.Stringify(parseRaw(t, c)))
			}
			b = strings.Join(ls, "\n") + "\n"
		}
		if err := os.WriteFile(p, []byte(b), 0o666); err != nil {
			t.Fatal(err)
		}
		tm := time.UnixMilli(int64(now - age))
		_ = os.Chtimes(p, tm, tm)
	}
	for _, f := range g.Fixture {
		write(f.Rel, f.Raw, f.Content, f.Age, g.Now0)
	}
	scrub := func(v any) any {
		s := util.Stringify(v)
		hs := util.Stringify(H)
		s = strings.ReplaceAll(s, hs[1:len(hs)-1], "<H>")
		s = strings.ReplaceAll(s, `\\`, "/")
		var out any
		_ = json.Unmarshal([]byte(s), &out)
		return out
	}
	now := g.Now0
	procs := []AgentProc{{1, "claude", "/w/app"}, {2, "gemini", ""}, {3, "codex", ""}, {4, "claude", "/w/old"}}
	st, err := os.Stat(filepath.Join(H, ".dsh/sessions/d1/session.lock"))
	if err != nil {
		t.Fatal(err)
	}
	locks := map[float64]bool{inoOf(st): true}
	log := []any{}
	var svc *Service
	jsrt.Run(func() {
		svc = New(Deps{
			Root: filepath.Join(H, "userData/agents"), Logger: capLog{&log}, Events: capEvents{&log},
			Notify: func(n Notice) { log = append(log, []any{"notice", sortedNotice(n)}) },
			Home:   H, Now: func() float64 { return now }, PollMs: 1e9, DigestMs: 1e9,
			Processes: func() []AgentProc { return procs }, LockedInodes: func() map[float64]bool { return locks },
			DshHome: filepath.Join(H, ".dsh"), GrokHome: filepath.Join(H, ".grok"), IsQuiet: func() bool { return false },
			UsageOf: func(s, id string) *util.Obj {
				if s == "claude" && id == "c1" {
					return util.NewObj("tokens", 42.0, "cost", 0.5)
				}
				return nil
			},
			TaskCost: func(q CostQuery) *jsrt.Promise[string] {
				if q.Source == "codex" {
					return jsrt.Resolved("")
				}
				sess := q.Session
				if sess == "" {
					sess = "-"
				}
				return jsrt.Resolved("cost:" + q.Source + ":" + sess + ":" + util.JSString(q.Since))
			},
		})
	})
	steps := []any{}
	gil := func(f func()) { jsrt.Run(f) }
	snap := func(name string, extra ...any) {
		gil(func() {
			o := util.NewObj("name", name, "now", now)
			for i := 0; i+1 < len(extra); i += 2 {
				o.Set(extra[i].(string), extra[i+1])
			}
			o.Set("state", svc.State())
			l := make([]any, len(log))
			for i, x := range log {
				r := x.([]any)
				if r[0] == "event" && r[2] == nil {
					r = []any{r[0], r[1], nil}
				}
				l[i] = r
			}
			o.Set("log", l)
			log = log[:0]
			steps = append(steps, scrub(o))
		})
	}
	tick := func(refresh bool) {
		p := jsrt.Call(func() *jsrt.Promise[struct{}] { return svc.Tick(refresh) })
		if _, err := jsrt.Block(p); err != nil {
			t.Fatal(err)
		}
	}
	set := func(patch string) *util.Obj {
		return jsrt.Call(func() *util.Obj {
			v, err := svc.SetSettings(parseRaw(t, []byte(patch)))
			if err != nil {
				t.Fatal(err)
			}
			return v
		})
	}
	stop := func() { gil(svc.Stop) }
	digest := func() bool { return jsrt.Call(svc.Digest) }

	snap("initial")
	s1 := set(`{"tools":{"grok":true,"bogus":1},"stallMs":120000,"cooldownMs":30000,"extra":1}`)
	tick(false)
	stop()
	snap("setSettings", "ret", s1)
	now += 10 * 60_000
	tick(true)
	snap("stalled")
	tick(true)
	snap("stalled-again")
	{
		p := filepath.Join(H, filepath.FromSlash(g.Fixture[0].Rel))
		f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
		_, _ = f.WriteString(util.Stringify(parseRaw(t, g.AppendClaude)) + "\n")
		_ = f.Close()
		tm := time.UnixMilli(int64(now))
		_ = os.Chtimes(p, tm, tm)
	}
	gil(func() {
		locks = map[float64]bool{}
		procs = []AgentProc{{2, "gemini", ""}}
	})
	now += 5_000
	tick(true)
	snap("done")
	s2 := set(`{"summaryEnabled":true}`)
	tick(false)
	stop()
	snap("summary-on", "ret", s2)
	mk := func(s string) *util.Obj { return util.AsObj(parseRaw(t, []byte(s))) }
	var tabs []*util.Obj
	gil(func() {
		t1 := mk(`{"id":"t1","backend":"claude","cliSessionId":"c1","title":"Tab one","status":"running","unread":0,"cwd":"/w/app"}`)
		t1.Set("updatedAt", now-1000)
		t2 := mk(`{"id":"t2","backend":"nomi","title":"Chat","status":"queued","unread":0,"cwd":""}`)
		t2.Set("updatedAt", now-2000)
		t3 := mk(`{"id":"t3","backend":"codex","cliSessionId":"cx9","title":"Svc","status":"error","lastError":"boom","unread":1,"cwd":"/w/svc"}`)
		t3.Set("updatedAt", now-3000)
		t4 := mk(`{"id":"t4","backend":"grok","title":"Grok","status":"running","unread":0,"cwd":"/w/g"}`)
		t4.Set("updatedAt", now-4000)
		tabs = []*util.Obj{t1, t2, t3, t4}
	})
	var hTabs func()
	var hFin func(EndpointFinished)
	var hPerm func(EndpointPermissionNeeded)
	gil(func() {
		svc.AttachHarness(Harness{
			Tabs:   func() []*util.Obj { return tabs },
			OnTabs: func(fn func()) { hTabs = fn }, OnFinished: func(fn func(EndpointFinished)) { hFin = fn },
			OnPermission: func(fn func(EndpointPermissionNeeded)) { hPerm = fn },
			Progress: func(id string) string {
				if id == "t1" {
					return "running ```npm``` tests now"
				}
				return ""
			},
		})
		hTabs()
	})
	snap("tabs")
	now += 70_000
	digest()
	snap("digest-1")
	gil(func() {
		hFin(EndpointFinished{TabID: "t2", Title: "Chat", Backend: "nomi", Ok: true, Text: "All ```code``` done   well", Background: true})
		hFin(EndpointFinished{TabID: "t3", Title: "Svc", Backend: "codex", Ok: false, Error: "crashed hard", Background: true})
		hFin(EndpointFinished{TabID: "t1", Title: "Tab one", Backend: "claude", Ok: true, Text: "fg"})
	})
	time.Sleep(50 * time.Millisecond)
	snap("finished")
	gil(func() {
		hPerm(EndpointPermissionNeeded{TabID: "t1", Title: "Tab one", Backend: "claude", Summary: "  run   rm -rf build  "})
		hPerm(EndpointPermissionNeeded{TabID: "t1", Title: "Tab one", Backend: "gemini", Background: true})
	})
	snap("permission")
	d1 := digest()
	now += 61_000
	d2 := digest()
	snap("digest-2", "d1", d1, "d2", d2)
	set(`{"summaryEnabled":false,"tools":{"claude":false}}`)
	tick(false)
	stop()
	now += 61_000
	d3 := digest()
	gil(func() {
		hFin(EndpointFinished{TabID: "t1", Title: "Tab one", Backend: "claude", Ok: true, Text: "x", Background: true})
	})
	snap("claude-off", "d3", d3)
	gil(func() { procs = nil })
	tick(true)
	snap("no-procs")
	app := func(line json.RawMessage, tm float64) {
		p := filepath.Join(H, filepath.FromSlash(g.Fixture[0].Rel))
		f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
		_, _ = f.WriteString(util.Stringify(parseRaw(t, line)) + "\n")
		_ = f.Close()
		ts := time.UnixMilli(int64(tm))
		_ = os.Chtimes(p, ts, ts)
	}
	set(`{"tools":{"claude":true,"codex":false}}`)
	tick(false)
	stop()
	gil(func() { procs = []AgentProc{{1, "claude", "/w/app"}}; now = g.Now0 + 900_000 })
	app(g.AppendTool, now)
	tick(true)
	snap("c1-running")
	gil(func() { now += 200_000 })
	tick(true)
	snap("c1-stalled")
	gil(func() { now = g.Now0 + 1_200_000 })
	app(g.AppendDone, now)
	tick(true)
	snap("c1-waiting")
	set(`{"enabled":false,"tools":{"gemini":false}}`)
	tick(true)
	d4 := digest()
	gil(func() { tabs = nil })
	sf, _ := os.ReadFile(filepath.Join(H, "userData/agents/settings.json"))
	snap("disabled", "d4", d4, "settingsFile", parseRaw(t, sf))

	if len(steps) != len(g.Steps) {
		t.Fatalf("steps %d want %d", len(steps), len(g.Steps))
	}
	for i := range steps {
		eq(t, "step "+util.JSString(float64(i)), steps[i], g.Steps[i])
	}
}
