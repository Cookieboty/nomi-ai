package contract_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type I = clisdk.CliMainImpl

func cp[T any](p *T) *T {
	if p == nil {
		return nil
	}
	c := *p
	return &c
}

func cloneEnv(o *util.Obj) *util.Obj {
	n := util.NewObj()
	if o != nil {
		for _, k := range o.Keys() {
			n.Set(k, o.Get(k))
		}
	}
	return n
}

func wrapOfficial(i *I, f func(clisdk.AgentLaunch) clisdk.AgentLaunch) *I {
	orig := i.Launch.Official
	i.Launch.Official = func(c clisdk.LaunchContext) clisdk.AgentLaunch { return f(orig(c)) }
	return i
}

// 与 record-b7s2-contract.mjs 的 V 同名同义
var variants = map[string]func(*I) *I{
	"none":            func(i *I) *I { return i },
	"noHistory":       func(i *I) *I { i.History = nil; return i },
	"noHistoryResume": func(i *I) *I { i.History = cp(i.History); i.History.Resume = nil; return i },
	"noHistoryParse": func(i *I) *I {
		if i.History != nil {
			i.History = cp(i.History)
			i.History.Parse = nil
		}
		return i
	},
	"noAccounts":       func(i *I) *I { i.Accounts = nil; return i },
	"noTerminal":       func(i *I) *I { i.Terminal = nil; return i },
	"noProgress":       func(i *I) *I { i.Progress = nil; return i },
	"noUsage":          func(i *I) *I { i.Usage = nil; return i },
	"noPermissions":    func(i *I) *I { i.Permissions = nil; return i },
	"noPlaceholder":    func(i *I) *I { i.Launch.PlaceholderModel = ""; return i },
	"otherPlaceholder": func(i *I) *I { i.Launch.PlaceholderModel = "other"; return i },
	"supportedDiffer": func(i *I) *I {
		i.Permissions = cp(i.Permissions)
		i.Permissions.Supported = i.Permissions.Supported[1:]
		return i
	},
	"launchNondet": func(i *I) *I {
		n := 0
		i.Permissions = cp(i.Permissions)
		i.Permissions.Launch = func(m string, _ *bool) ([]string, *util.Obj) {
			n++
			return []string{m, fmt.Sprint(n - 1)}, util.NewObj()
		}
		return i
	},
	"launchArgsDiffer": func(i *I) *I {
		i.Permissions = cp(i.Permissions)
		i.Permissions.Launch = func(string, *bool) ([]string, *util.Obj) { return []string{"x"}, util.NewObj() }
		return i
	},
	"modeIdDiffer": func(i *I) *I {
		i.Permissions = cp(i.Permissions)
		i.Permissions.ModeID = func(string) string { return "zzz" }
		return i
	},
	"officialNondet": func(i *I) *I {
		n := 0
		return wrapOfficial(i, func(a clisdk.AgentLaunch) clisdk.AgentLaunch {
			a.Args = append(append([]string{}, a.Args...), fmt.Sprint(n))
			n++
			return a
		})
	},
	"officialSecret": func(i *I) *I {
		return wrapOfficial(i, func(a clisdk.AgentLaunch) clisdk.AgentLaunch {
			a.Args = append(append([]string{}, a.Args...), "sk-abcdefghijkl", "ok")
			a.Env = cloneEnv(a.Env)
			a.Env.Set("K", "Bearer abcdefgh")
			a.Env.Set("G", "ghp_abcdefghijklmn")
			return a
		})
	},
	"officialNoHome": func(i *I) *I {
		acc := i.Accounts
		return wrapOfficial(i, func(a clisdk.AgentLaunch) clisdk.AgentLaunch {
			env := util.NewObj()
			for _, k := range a.Env.Keys() {
				if acc == nil || k != acc.HomeEnv {
					env.Set(k, a.Env.Get(k))
				}
			}
			a.Env = env
			return a
		})
	},
	"stripMissing": func(i *I) *I {
		if i.Accounts != nil {
			i.Accounts = cp(i.Accounts)
			i.Accounts.Strip = []string{}
		}
		return i
	},
	"sharedBad": func(i *I) *I {
		if i.Accounts != nil {
			i.Accounts = cp(i.Accounts)
			i.Accounts.Shared = []clisdk.SharedEntry{{Name: "/abs"}, {Name: "a/../b"}, {Name: "ok/x"}, {Name: `..\x`}, {Name: "..x"}}
		}
		return i
	},
	"loginEmpty": func(i *I) *I {
		if i.Accounts != nil {
			i.Accounts = cp(i.Accounts)
			i.Accounts.LoginArgs = []string{}
		}
		return i
	},
	"officialFilesNondet": func(i *I) *I {
		n := 0
		return wrapOfficial(i, func(a clisdk.AgentLaunch) clisdk.AgentLaunch {
			a.Files = []clisdk.LaunchFile{{Path: "f", Content: fmt.Sprint(n)}}
			n++
			return a
		})
	},
	"officialHomeNondet": func(i *I) *I {
		n := 0
		return wrapOfficial(i, func(a clisdk.AgentLaunch) clisdk.AgentLaunch {
			a.PrivateHome = &clisdk.PrivateHome{EnvVar: "H", Shared: fmt.Sprint(n), KeepPrivate: []string{}}
			n++
			return a
		})
	},
	"officialThrows": func(i *I) *I {
		i.Launch.Official = func(clisdk.LaunchContext) clisdk.AgentLaunch { panic(errors.New("boom")) }
		return i
	},
	"parseThrows": func(i *I) *I {
		i.History = cp(i.History)
		i.History.Parse = func(string, clisdk.HistoryFileRef) *util.Obj { panic(errors.New("kaboom")) }
		return i
	},
	"parseNoMeta": func(i *I) *I {
		i.History = cp(i.History)
		i.History.Parse = func(string, clisdk.HistoryFileRef) *util.Obj { return util.NewObj("messages", []any{1.0, 2.0}) }
		return i
	},
	"parseNoTitle": func(i *I) *I {
		i.History = cp(i.History)
		i.History.Parse = func(string, clisdk.HistoryFileRef) *util.Obj {
			return util.NewObj("meta", util.NewObj(), "messages", []any{})
		}
		return i
	},
}

func synth(name string) clisdk.CliPlugin {
	switch name {
	case "bad-manifest":
		return clisdk.CliPlugin{Manifest: util.NewObj("id", "Bad!", "apiVersion", 2.0), Main: builtin.Plugins["claude"].Main}
	case "bad-manifest-null":
		return clisdk.CliPlugin{Manifest: nil, Main: builtin.Plugins["claude"].Main}
	case "no-main":
		return clisdk.CliPlugin{Manifest: builtin.Plugins["claude"].Manifest}
	case "main-throws":
		return clisdk.CliPlugin{Manifest: builtin.Plugins["claude"].Manifest, Main: func(clisdk.CliMainHost) (*clisdk.CliMainImpl, error) {
			return nil, errors.New("nope")
		}}
	}
	panic("unknown synthetic plugin " + name)
}

type gfix struct {
	Name, Path, Text string
	Expect           struct {
		Messages *int
		Title    *string
		Error    bool
	}
}

// 与 Node checkPlugin 逐场景对拍（record-b7s2-contract.mjs）
func TestCheckPluginParity(t *testing.T) {
	gp, _ := paritytest.Golden(t, "b7s2-contract.json", filepath.Join("testdata", "b7s2-contract.json"))
	raw, err := os.ReadFile(gp)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Scenarios []struct {
			Name, Plugin, Variant string
			Fixtures              []gfix
			Patch                 json.RawMessage
			Out                   json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	for _, s := range g.Scenarios {
		p, ok := builtin.Plugins[s.Plugin]
		if !ok {
			p = synth(s.Plugin)
		}
		if len(s.Patch) > 0 {
			p = withPatch(t, p, string(s.Patch))
		}
		v := variants[s.Variant]
		if v == nil {
			t.Fatalf("%s: unknown variant %s", s.Name, s.Variant)
		}
		fx := []contract.HistoryFixture{}
		for _, f := range s.Fixtures {
			fx = append(fx, contract.HistoryFixture{Name: f.Name, Path: f.Path, Text: f.Text, Messages: f.Expect.Messages, Title: f.Expect.Title, Error: f.Expect.Error})
		}
		o := contract.Options{HistoryFixtures: fx}
		if s.Variant != "none" {
			o.Extend = func(i *I) *I { c := *i; return v(&c) }
		}
		ps, err := contract.CheckPlugin(p, o)
		var got any = ps
		if err != nil {
			got = map[string]string{"threw": err.Error()}
		} else if ps == nil {
			got = []string{}
		}
		gb, _ := json.Marshal(got)
		var a, b any
		_ = json.Unmarshal(gb, &a)
		_ = json.Unmarshal(s.Out, &b)
		if ab, bb := mustJSON(a), mustJSON(b); ab != bb {
			t.Errorf("%s:\n got  %s\n want %s", s.Name, ab, bb)
		}
	}
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

// withPatch：深拷贝清单并给每个 permissionModes 项设字段（同 recorder 的 structuredClone + pm[k]=v）
func withPatch(t *testing.T, p clisdk.CliPlugin, patch string) clisdk.CliPlugin {
	m, err := util.ParseString(util.Stringify(p.Manifest))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := util.ParseString(patch)
	if err != nil {
		t.Fatal(err)
	}
	mo := m.(*util.Obj)
	if caps, ok := mo.Get("capabilities").(*util.Obj); ok {
		if pms, ok := caps.Get("permissionModes").([]any); ok {
			for _, pm := range pms {
				for _, k := range pt.(*util.Obj).Keys() {
					pm.(*util.Obj).Set(k, pt.(*util.Obj).Get(k))
				}
			}
		}
	}
	p.Manifest = mo
	return p
}
