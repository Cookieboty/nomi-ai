package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type hostScenario struct {
	Name string `json:"name"`
	Deps *struct {
		Home        string            `json:"home"`
		Env         map[string]string `json:"env"`
		Platform    string            `json:"platform"`
		Version     map[string]any    `json:"version"`
		Extend      bool              `json:"extend"`
		VersionHook string            `json:"versionHook"`
		ExternalDir string            `json:"externalDir"`
		RemovedHook any               `json:"removedHook"`
		Spawn       string            `json:"spawn"`
		Builtin     bool              `json:"builtin"`
	} `json:"deps"`
	Plugins []struct {
		Key      string          `json:"key"`
		Manifest json.RawMessage `json:"manifest"`
		Main     string          `json:"main"`
	} `json:"plugins"`
	Files []struct{ P, Text string } `json:"files"`
	Steps []json.RawMessage          `json:"steps"`
	Out   []json.RawMessage          `json:"out"`
}

type hostEvents struct{ calls *[]any }

func (e hostEvents) Publish(ev string, p any) {
	ids := []any{}
	for _, x := range p.(*util.Obj).Get("plugins").([]any) {
		o := x.(*util.Obj)
		ids = append(ids, util.JSString(o.Get("id"))+":"+util.JSString(o.Get("status"))+":"+jsNullStr(o.Get("version")))
	}
	*e.calls = append(*e.calls, []any{"publish", ev, ids})
}

type hostLog struct{ calls *[]any }

func (l hostLog) Info(m string, d any) { *l.calls = append(*l.calls, []any{"info", m, d}) }
func (l hostLog) Warn(m string, d any) { *l.calls = append(*l.calls, []any{"warn", m, d}) }

var hostTmpRe = regexp.MustCompile(`[\\/]nomi-cli-test-[^\\/]+$`)

func TestCliPluginHostGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s-host.json", filepath.Join("testdata", "b7s-host.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Platform  string         `json:"platform"`
		Scenarios []hostScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if g.Platform != usage.Platform() {
		t.Skipf("golden recorded on %s", g.Platform)
	}
	node := findNode(t)
	steps := 0
	for _, sc := range g.Scenarios {
		steps += len(sc.Steps)
		t.Run(sc.Name, func(t *testing.T) { runHostScenario(t, sc, node) })
	}
	if len(g.Scenarios) < 10 || steps < 130 {
		t.Fatalf("golden too small: %d/%d", len(g.Scenarios), steps)
	}
}

func runHostScenario(t *testing.T, sc hostScenario, node string) {
	SB, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sub := func(s string) string { return strings.ReplaceAll(s, shTok, SB) }
	_ = os.MkdirAll(filepath.Join(SB, "work"), 0o777)
	_ = os.MkdirAll(filepath.Join(SB, "home"), 0o777)
	for _, f := range sc.Files {
		p := filepath.Join(append([]string{SB}, strings.Split(f.P, "/")...)...)
		_ = os.MkdirAll(filepath.Dir(p), 0o777)
		if err := os.WriteFile(p, []byte(f.Text), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	calls := []any{}
	var host *CliPluginHost
	versions := map[string]any{}
	if d := sc.Deps; d != nil {
		for k, v := range d.Version {
			versions[k] = v
		}
		home := sub(d.Home)
		deps := CliPluginHostDeps{Logger: hostLog{&calls}, Root: filepath.Join(SB, "root"), Home: &home, Env: d.Env,
			Platform: d.Platform, Events: hostEvents{&calls}}
		if deps.Env == nil {
			deps.Env = clisdk.Env{}
		}
		if !d.Builtin {
			deps.Plugins = []NamedPlugin{}
			for _, sp := range sc.Plugins {
				sp := sp
				var m *util.Obj
				if v, _ := util.ParseString(string(sp.Manifest)); v != nil {
					m = v.(*util.Obj)
				}
				pl := clisdk.CliPlugin{Manifest: m}
				if sp.Main != "none" {
					pl.Main = func(h clisdk.CliMainHost) (*clisdk.CliMainImpl, error) {
						env := util.NewObj()
						keys := []string{}
						for k := range h.Env {
							keys = append(keys, k)
						}
						sort.Strings(keys)
						for _, k := range keys {
							env.Set(k, h.Env[k])
						}
						calls = append(calls, []any{"main", sp.Key, util.NewObj("dataDir", h.DataDir, "home", h.Home, "platform", h.Platform, "env", env)})
						if strings.HasPrefix(sp.Main, "throw:") {
							return nil, errors.New(sp.Main[6:])
						}
						return &clisdk.CliMainImpl{}, nil
					}
				}
				deps.Plugins = append(deps.Plugins, NamedPlugin{sp.Key, pl})
			}
		}
		if d.Version != nil {
			deps.Version = func(id string) *jsrt.Promise[*string] {
				calls = append(calls, []any{"version", id})
				return jsrt.Async(func() (*string, error) {
					v := versions[id]
					if v == "throw" {
						return nil, errors.New("no cli")
					}
					if s, ok := v.(string); ok {
						return &s, nil
					}
					return nil, nil
				})
			}
		}
		if d.Extend {
			deps.Extend = func(id string, impl *clisdk.CliMainImpl) *clisdk.CliMainImpl {
				calls = append(calls, []any{"extend", id})
				return impl
			}
		}
		if d.VersionHook != "" {
			deps.OnVersionChange = func(id, a, b string) {
				calls = append(calls, []any{"versionChange", id, a, b})
				if d.VersionHook == "throw" {
					panic(errors.New("hook boom"))
				}
			}
		}
		if d.ExternalDir != "" {
			deps.ExternalDir = sub(d.ExternalDir)
		}
		if d.RemovedHook != nil && d.RemovedHook != false {
			deps.OnExternalRemoved = func(id string) {
				calls = append(calls, []any{"removed", id})
				if d.RemovedHook == "throw" {
					panic(errors.New("rm boom"))
				}
			}
		}
		if d.Spawn != "" {
			deps.SpawnExternal = func(cmd string, args []string, cwd string) (clisdk.ChildLike, error) {
				rc := any(cwd)
				if hostTmpRe.MatchString(cwd) {
					_, e := os.Stat(cwd)
					rc = "<TMP>:" + map[bool]string{true: "true", false: "false"}[e == nil]
				}
				calls = append(calls, []any{"spawn", cmd, hostStrs(args), rc})
				if d.Spawn == "throw" {
					return nil, errors.New("spawn blew up")
				}
				return clisdk.ProcChild{Child: nodeproc.Spawn(node, append([]string{cmd}, args...), nodeproc.Options{Cwd: cwd})}, nil
			}
		}
		host = NewCliPluginHost(deps)
	}
	for i, raw := range sc.Steps {
		v, _ := util.ParseString(sub(string(raw)))
		st := v.([]any)
		op := st[0].(string)
		a := func(k int) string { s, _ := st[k].(string); return s }
		var r any
		undef := false
		jsrt.Run(func() {
			switch op {
			case "inRange":
				r = InRange(a(1), a(2))
			case "start":
				_, _ = jsrt.Await(host.Start())
				undef = true
			case "tick":
				jsrt.Sleep(20 * time.Millisecond)
				undef = true
			case "calls":
				r = calls
				calls = []any{}
			case "snapshot":
				r = host.Snapshot()
			case "impl":
				r = host.Impl(a(1)) != nil
			case "manifest":
				m, ok := host.Manifest(a(1))
				r, undef = m, !ok
			case "caps":
				if c := host.Capabilities(a(1)); c != nil {
					r = c
				} else {
					undef = true
				}
			case "extSpec":
				if c := host.ExternalSpec(a(1)); c != nil {
					r = c
				} else {
					undef = true
				}
			case "handshake":
				o, _ := st[2].(*util.Obj)
				host.SetHandshake(a(1), o)
				undef = true
			case "setVersion":
				versions[a(1)] = st[2]
				undef = true
			case "refresh":
				_, _ = jsrt.Await(host.RefreshVersions())
				undef = true
			case "remove":
				r = host.RemoveExternal(a(1))
			case "stop":
				host.Stop()
				undef = true
			case "add":
				r = host.AddExternal(st[1])
			case "test":
				r, _ = jsrt.Await(host.TestExternal(st[1], a(2)))
			case "testTemp":
				r, _ = jsrt.Await(host.TestExternalInTemp(st[1]))
			case "ls":
				ents, _ := os.ReadDir(filepath.Join(append([]string{SB}, strings.Split(a(1), "/")...)...))
				names := []any{}
				for _, e := range ents {
					names = append(names, e.Name())
				}
				r = names
			default:
				t.Fatalf("bad op %s", op)
			}
		})
		got := `{"undef":true}`
		if !undef {
			got = strings.ReplaceAll(util.Stringify(util.NewObj("v", r)), jsonEsc(SB), "<SB>")
		}
		want := canonJSON(t, sc.Out[i])
		if gg := canonJSON(t, []byte(got)); gg != want {
			t.Errorf("%s step %d %s:\n got %s\nwant %s", sc.Name, i, trunc(string(raw)), trunc(gg), trunc(want))
		}
	}
}

func jsNullStr(v any) string {
	if v == nil {
		return "null"
	}
	return util.JSString(v)
}
