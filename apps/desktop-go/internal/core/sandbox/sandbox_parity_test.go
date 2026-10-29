package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type jsCase struct {
	Name      string         `json:"name"`
	Code      string         `json:"code"`
	TimeoutMs int            `json:"timeoutMs"`
	Stdin     string         `json:"stdin"`
	AbortMs   int            `json:"abortMs"`
	Out       map[string]any `json:"out"`
}

type sandboxGolden struct {
	BwrapCases []struct {
		In struct {
			Python       string    `json:"python"`
			ScriptPath   string    `json:"scriptPath"`
			TmpDir       string    `json:"tmpDir"`
			AllowNetwork bool      `json:"allowNetwork"`
			PythonArgs   *[]string `json:"pythonArgs"`
			Ex           []string  `json:"ex"`
		} `json:"in"`
		Out []string `json:"out"`
	} `json:"bwrapCases"`
	Seatbelt []struct {
		In struct {
			TmpDir       string `json:"tmpDir"`
			Python       string `json:"python"`
			AllowNetwork bool   `json:"allowNetwork"`
		} `json:"in"`
		Out string `json:"out"`
	} `json:"seatbelt"`
	Plans []struct {
		In  map[string]json.RawMessage `json:"in"`
		Out Plan                       `json:"out"`
	} `json:"plans"`
	Host struct {
		FindMissing     *string      `json:"findMissing"`
		FindBwrap       *string      `json:"findBwrap"`
		FindSandboxExec *string      `json:"findSandboxExec"`
		Available       Availability `json:"available"`
		AvailableWin    Availability `json:"availableWin"`
		AvailableAix    Availability `json:"availableAix"`
		PlanHost        Plan         `json:"planHost"`
	} `json:"host"`
	Sync []struct {
		In  string         `json:"in"`
		Out RequestVerdict `json:"out"`
	} `json:"sync"`
	AssertCases []struct {
		In  string `json:"in"`
		Out struct {
			Ok  *string `json:"ok"`
			Err *string `json:"err"`
		} `json:"out"`
	} `json:"assertCases"`
	Steps []struct {
		Op      string          `json:"op"`
		In      string          `json:"in"`
		IP      *string         `json:"ip"`
		Out     json.RawMessage `json:"out"`
		Lookups []string        `json:"lookups"`
		Blocked []string        `json:"blocked"`
	} `json:"steps"`
	JS       []jsCase       `json:"js"`
	Avail    []string       `json:"avail"`
	Py       []jsCase       `json:"py"`
	Minimal  map[string]any `json:"minimal"`
	Minimal2 []string       `json:"minimal2"`
	Platform string         `json:"platform"`
}

func loadGolden(t *testing.T) (*sandboxGolden, string) {
	t.Helper()
	p, _ := paritytest.Golden(t, "b7s2-sandbox.json", filepath.Join("testdata", "b7s2-sandbox.json"))
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	mk, err := os.MkdirTemp(os.TempDir(), "sbx-rec-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(mk) })
	root, _ := realpath(mk)
	esc, _ := json.Marshal(root)
	s := strings.ReplaceAll(string(raw), "@@ROOT@@", string(esc[1:len(esc)-1]))
	var g sandboxGolden
	if err := json.Unmarshal([]byte(s), &g); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(root, "pybin"), 0o755)
	os.WriteFile(filepath.Join(root, "pybin", "python3"), nil, 0o644)
	if g.Platform != NodePlatform() {
		paritytest.SkipOrFail(t, "golden recorded on", g.Platform)
	}
	return &g, root
}

func hasFn(xs []string) func(string) bool { return func(p string) bool { return contains(xs, p) } }

func TestSandboxPlatformParity(t *testing.T) {
	g, _ := loadGolden(t)
	for i, c := range g.BwrapCases {
		o := BwrapOpts{Python: c.In.Python, ScriptPath: c.In.ScriptPath, TmpDir: c.In.TmpDir, AllowNetwork: c.In.AllowNetwork, Exists: hasFn(c.In.Ex)}
		if c.In.PythonArgs != nil {
			o.PythonArgs = append([]string{}, *c.In.PythonArgs...)
		}
		if got := BuildBwrapArgs(o); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("bwrap[%d]\n got %q\nwant %q", i, got, c.Out)
		}
	}
	for i, c := range g.Seatbelt {
		if got := BuildSeatbeltProfile(c.In.TmpDir, c.In.Python, c.In.AllowNetwork); got != c.Out {
			t.Errorf("seatbelt[%d]\n got %q\nwant %q", i, got, c.Out)
		}
	}
	opt := func(raw json.RawMessage, ok bool) OptPath {
		if !ok {
			return OptPath{}
		}
		var p *string
		_ = json.Unmarshal(raw, &p)
		return OptPath{Set: true, Path: p}
	}
	for i, c := range g.Plans {
		o := PlanOpts{Python: "/fake/py", ScriptPath: "/t/main.py", TmpDir: "/t"}
		_ = json.Unmarshal(c.In["platform"], &o.Platform)
		if v, ok := c.In["allowNetwork"]; ok {
			_ = json.Unmarshal(v, &o.AllowNetwork)
		}
		var ex []string
		if v, ok := c.In["ex"]; ok {
			_ = json.Unmarshal(v, &ex)
		}
		o.Exists = hasFn(ex)
		b, okb := c.In["bwrapPath"]
		o.BwrapPath = opt(b, okb)
		sx, oks := c.In["sandboxExecPath"]
		o.SandboxExecPath = opt(sx, oks)
		if got := PlanPythonSandbox(o); !reflect.DeepEqual(got, c.Out) {
			t.Errorf("plan[%d] %s\n got %#v\nwant %#v", i, c.In["platform"], got, c.Out)
		}
	}
	h := g.Host
	eqp := func(name string, got, want *string) {
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("%s: got %v want %v", name, got, want)
		}
	}
	eqp("findMissing", FindOnPath("definitely-missing-nomi-xyz", ""), h.FindMissing)
	eqp("findBwrap", FindOnPath("bwrap", ""), h.FindBwrap)
	eqp("findSandboxExec", FindOnPath("sandbox-exec", ""), h.FindSandboxExec)
	for _, c := range []struct {
		p    string
		want Availability
	}{{"", h.Available}, {"win32", h.AvailableWin}, {"aix", h.AvailableAix}} {
		if got := PythonPlatformSandboxAvailable(c.p); got != c.want {
			t.Errorf("available(%q): got %#v want %#v", c.p, got, c.want)
		}
	}
	if got := PlanPythonSandbox(PlanOpts{Python: "/fake/py", ScriptPath: "/t/main.py", TmpDir: "/t", Exists: func(string) bool { return false }}); !reflect.DeepEqual(got, h.PlanHost) {
		t.Errorf("planHost\n got %#v\nwant %#v", got, h.PlanHost)
	}
}

func TestSandboxGuardParity(t *testing.T) {
	g, _ := loadGolden(t)
	for _, c := range g.Sync {
		if got := CheckRequestUrlSync(c.In); got != c.Out {
			t.Errorf("sync(%q): got %#v want %#v", c.In, got, c.Out)
		}
	}
	if len(g.AssertCases) == 0 {
		t.Fatal("no assertCases")
	}
	for _, c := range g.AssertCases {
		u, err := security.AssertPublicHttpUrl(c.In)
		var gotOk, gotErr *string
		if err != nil {
			e := err.Error()
			gotErr = &e
		} else {
			gotOk = &u.Hostname
		}
		if !reflect.DeepEqual(gotOk, c.Out.Ok) || !reflect.DeepEqual(gotErr, c.Out.Err) {
			t.Errorf("assertPublicHttpUrl(%q): got ok=%v err=%v want ok=%v err=%v", c.In, ptr(gotOk), ptr(gotErr), ptr(c.Out.Ok), ptr(c.Out.Err))
		}
	}
	dns := map[string][]security.LookupAddress{
		"example.com": {{Address: "93.184.216.34", Family: 4}},
		"rebind.test": {{Address: "93.184.216.34", Family: 4}, {Address: "10.0.0.5", Family: 4}},
		"v6.test":     {{Address: "::1", Family: 6}},
		"empty.test":  {},
		"pub6.test":   {{Address: "2606:2800:220:1::", Family: 6}},
		"mapped.test": {{Address: "::ffff:192.168.0.1", Family: 6}},
	}
	lookups := []string{}
	lookup := func(h string) ([]security.LookupAddress, error) {
		lookups = append(lookups, h)
		switch h {
		case "boom.test":
			return nil, errors.New("getaddrinfo ENOTFOUND boom.test")
		case "odd.test":
			return nil, errors.New("plain string")
		}
		if a, ok := dns[h]; ok {
			return a, nil
		}
		return []security.LookupAddress{{Address: "1.1.1.1", Family: 4}}, nil
	}
	guard := NewRequestGuard(RequestGuardOptions{LookupAll: lookup})
	for i, s := range g.Steps {
		switch s.Op {
		case "decide", "fresh":
			gd := guard
			in := s.In
			if s.Op == "fresh" {
				gd, in = NewRequestGuard(RequestGuardOptions{LookupAll: lookup}), "https://other.test/z"
			}
			var want RequestVerdict
			_ = json.Unmarshal(s.Out, &want)
			got := gd.DecideRequest(in)
			if got != want || !reflect.DeepEqual(lookups, s.Lookups) {
				t.Errorf("step %d decide(%q): got %#v %q want %#v %q", i, in, got, lookups, want, s.Lookups)
			}
			lookups = []string{}
		case "connected":
			ip := ""
			if s.IP != nil {
				ip = *s.IP
			}
			var want bool
			_ = json.Unmarshal(s.Out, &want)
			got := guard.OnConnected(s.In, ip)
			if got != want || !reflect.DeepEqual(guard.BlockedHosts(), s.Blocked) {
				t.Errorf("step %d connected(%q,%q): got %v %q want %v %q", i, s.In, ip, got, guard.BlockedHosts(), want, s.Blocked)
			}
		}
	}
}

var tmpTokRe = regexp.MustCompile("[^\\s'\"`]*cd-sbx-[A-Za-z0-9]+")

func norm(r *RunResult, name string, root string) map[string]any {
	b, _ := json.Marshal(r)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	ms := m["ms"].(float64)
	delete(m, "ms")
	m["msOk"] = ms >= 0
	m["stdout"] = tmpTokRe.ReplaceAllString(r.Stdout, "@@TMP@@")
	m["stderr"] = tmpTokRe.ReplaceAllString(r.Stderr, "@@TMP@@")
	if name == "throw" && strings.Contains(r.Stderr, "boom-x") {
		m["stderr"] = "HAS boom-x"
	}
	return m
}

func canon(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func TestSandboxCodeParity(t *testing.T) {
	g, root := loadGolden(t)
	node, err := exec.LookPath("node")
	if err != nil {
		paritytest.SkipOrFail(t, "node not on PATH")
		return
	}
	f := false
	sbx := New(Options{NodeBin: node, RunAsNode: &f})
	for _, c := range g.JS {
		s := sbx
		if c.Name == "run-as-node" {
			s = New(Options{NodeBin: node})
		}
		if c.Name == "missing-bin" {
			s = New(Options{NodeBin: filepath.Join(root, "no-node"), RunAsNode: &f})
		}
		ctx := context.Background()
		if c.AbortMs > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithCancel(ctx)
			time.AfterFunc(time.Duration(c.AbortMs)*time.Millisecond, cancel)
		}
		r, err := s.Run(ctx, "javascript", c.Code, RunOpts{TimeoutMs: c.TimeoutMs, Stdin: c.Stdin})
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got := norm(r, c.Name, root); !reflect.DeepEqual(canon(got), canon(c.Out)) {
			t.Errorf("js %s\n got %v\nwant %v", c.Name, got, c.Out)
		}
	}
	if got := sbx.Available(); !reflect.DeepEqual(got, g.Avail) {
		t.Errorf("available: got %v want %v", got, g.Avail)
	}
	for _, c := range g.Py {
		r, err := sbx.Run(context.Background(), "python", c.Code, RunOpts{TimeoutMs: 15000, Stdin: c.Stdin})
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got := norm(r, c.Name, root); !reflect.DeepEqual(canon(got), canon(c.Out)) {
			t.Errorf("py %s\n got %v\nwant %v", c.Name, got, c.Out)
		}
	}
	env := MinimalEnv("/T", []EnvVar{{"X", "1"}, {"HOME", "/override"}})
	keys := []string{}
	vals := map[string]string{}
	for _, e := range env {
		keys = append(keys, e.Key)
		vals[e.Key] = e.Value
	}
	kept := true
	for _, k := range []string{"PATH", "SYSTEMROOT", "WINDIR", "LANG", "TZ"} {
		if v, ok := lookupEnv(k); ok && v != "" && vals[k] != v {
			kept = false
		}
	}
	got := map[string]any{"keys": keys, "home": vals["HOME"], "x": vals["X"], "tmp": vals["TMP"], "keptMatch": kept}
	if !reflect.DeepEqual(canon(got), canon(g.Minimal)) {
		t.Errorf("minimalEnv: got %v want %v", got, g.Minimal)
	}
	keys2 := []string{}
	for _, e := range MinimalEnv("/T", nil) {
		keys2 = append(keys2, e.Key)
	}
	if !reflect.DeepEqual(keys2, g.Minimal2) {
		t.Errorf("minimalEnv2: got %v want %v", keys2, g.Minimal2)
	}
}

func ptr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}
