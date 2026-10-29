package shellhandlers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwagents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/terminal"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type termGolden struct {
	Scenarios []struct {
		Name     string   `json:"name"`
		Platform string   `json:"platform"`
		Shell    string   `json:"shell"`
		Rc       []string `json:"rc"`
		Mkdir    []string `json:"mkdir"`
		NoSource bool     `json:"noSource"`
		WinPath  *bool    `json:"winPath"`
		File     *string  `json:"file"`
		Steps    [][]any  `json:"steps"`
		Log      []struct {
			Step []any `json:"step"`
			Out  any   `json:"out"`
			Home any   `json:"home"`
			Root any   `json:"root"`
		} `json:"log"`
		WinCalls     any `json:"winCalls"`
		Warns        any `json:"warns"`
		EnabledCalls int `json:"enabledCalls"`
	} `json:"scenarios"`
	Scripts []struct {
		Kind, Platform, Name, Out string
		Model                     *string
	} `json:"scripts"`
	Rc []struct {
		In, Shell, Add, Remove string
	} `json:"rc"`
	Runner string `json:"runner"`
}

// termSource：golden 里的固定来源（与 record-shell.mjs 的 TSRC 一致）
func termSource() *terminal.Source {
	s := func(v string) *string { return &v }
	f := func(v float64) *float64 { return &v }
	b := func(v bool) *bool { return &v }
	cl := func(tok *string, kv ...any) *terminal.Client {
		return &terminal.Client{Token: tok, Models: u.NewObj(kv...)}
	}
	metas := map[string]*gwagents.ModelMeta{
		"p1/claude-x": {Label: s("Claude X"), Provider: s("P1"), Ctx: f(200000), MaxOutput: f(8192), Reasoning: b(true)},
		"p1/gpt-x":    {Label: s("GPT X"), Ctx: f(128000), Vision: b(true)},
		"p1/ds-x":     {Provider: s("P1"), Ctx: f(64000), MaxOutput: f(4096)},
	}
	return &terminal.Source{
		URL: "http://127.0.0.1:17890",
		Clients: map[string]*terminal.Client{
			"claude": cl(s("tok-claude"), "main", "p1/claude-x", "fast", "p1/haiku"),
			"codex":  cl(s("tok-codex"), "main", "p1/gpt-x"),
			"gemini": cl(nil),
			"grok":   cl(s("tok-grok"), "main", "p1/grok-x"),
			"dsh":    cl(s("tok-dsh"), "main", "p1/ds-x"),
		},
		MetaOf:  func(r string) *gwagents.ModelMeta { return metas[r] },
		Catalog: []string{"p1/claude-x", "p1/gpt-x", "p1/grok-x", "p1/ds-x"},
	}
}

func fileTree(dir string) map[string]any {
	out := map[string]any{}
	var walk func(d string)
	walk = func(d string) {
		es, err := os.ReadDir(d)
		if err != nil {
			return
		}
		sort.Slice(es, func(i, j int) bool { return es[i].Name() < es[j].Name() })
		for _, e := range es {
			f := filepath.Join(d, e.Name())
			rel, _ := filepath.Rel(dir, f)
			rel = filepath.ToSlash(rel)
			switch {
			case e.Type()&os.ModeSymlink != 0:
				l, _ := os.Readlink(f)
				out[rel] = map[string]any{"link": l}
			case e.IsDir():
				out[rel+"/"] = nil
				walk(f)
			default:
				b, _ := os.ReadFile(f)
				var mode any
				if runtime.GOOS != "windows" {
					st, _ := os.Stat(f)
					mode = float64(st.Mode().Perm())
				}
				text := string(b)
				if text == terminal.WindowsRunner {
					text = "<RUNNER>"
				}
				out[rel] = map[string]any{"text": text, "mode": mode}
			}
		}
	}
	walk(dir)
	return out
}

type warnRec struct{ w [][]string }

func (r *warnRec) Warn(m string, kv ...any) {
	e := ""
	if len(kv) > 0 {
		e = fmt.Sprint(kv[0])
		if er, ok := kv[0].(error); ok {
			e = er.Error()
		}
	}
	r.w = append(r.w, []string{m, e})
}

// treeDiff：只报告不同的条目（便于定位）
func treeDiff(got, want any) string {
	g, _ := got.(map[string]any)
	w, _ := want.(map[string]any)
	out := ""
	for k, v := range w {
		if gv, ok := g[k]; !ok {
			out += "\n  missing " + k
		} else if !reflect.DeepEqual(gv, v) {
			out += fmt.Sprintf("\n  diff %s:\n   got  %v\n   want %v", k, gv, v)
		}
	}
	for k := range g {
		if _, ok := w[k]; !ok {
			out += "\n  extra " + k
		}
	}
	return out
}

func TestTerminalParity(t *testing.T) {
	var g termGolden
	loadGolden(t, "shell_terminal.json", &g)
	if terminal.WindowsRunner != g.Runner {
		t.Errorf("nomi-runner.cjs drifted from windowsTerminal.ts (regenerate via esbuild)")
	}
	for _, c := range g.Rc {
		if got := terminal.AddRcBlock(c.In, c.Shell); got != c.Add {
			t.Errorf("addRcBlock(%q,%s)=%q want %q", c.In, c.Shell, got, c.Add)
		}
		if got := terminal.RemoveRcBlock(c.In); got != c.Remove {
			t.Errorf("removeRcBlock(%q)=%q want %q", c.In, got, c.Remove)
		}
	}
	for _, c := range g.Scripts {
		if got := terminal.CommandName(c.Kind, c.Platform); got != c.Name {
			t.Errorf("commandName(%s,%s)=%q want %q", c.Kind, c.Platform, got, c.Name)
		}
		in := &terminal.ScriptInput{Kind: c.Kind, Platform: c.Platform, URL: "http://127.0.0.1:17890", TokenFile: "/t/" + c.Kind, Model: c.Model}
		if c.Model != nil {
			in.Launch = &gwagents.Launch{Env: []gwagents.KV{{K: "A", V: "1"}, {K: "B", V: "it's"}}, Args: []string{"--x", "y z"}, Strip: []string{"S1"}}
			if c.Kind == "dsh" {
				tp := "/tpl/patch.yml"
				in.Template = &tp
			}
		}
		if got := terminal.BuildScript(in); got != c.Out {
			t.Errorf("buildScript(%s,%s,%v) mismatch:\n got %q\nwant %q", c.Kind, c.Platform, c.Model != nil, got, c.Out)
		}
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			sb, _ := filepath.EvalSymlinks(t.TempDir())
			base := filepath.Join(sb, "term", sc.Name)
			home, root := filepath.Join(base, "home"), filepath.Join(base, "root")
			_ = os.MkdirAll(home, 0o755)
			_ = os.MkdirAll(root, 0o755)
			for _, r := range sc.Rc {
				_ = os.WriteFile(filepath.Join(home, r), []byte("# existing\n"), 0o644)
			}
			for _, m := range sc.Mkdir {
				_ = os.MkdirAll(filepath.Join(home, m), 0o755)
			}
			if sc.File != nil {
				_ = os.WriteFile(filepath.Join(root, "terminal.json"), []byte(*sc.File), 0o644)
			}
			var src *terminal.Source
			if !sc.NoSource {
				src = termSource()
			}
			var winCalls []any
			warns := &warnRec{}
			enabled := 0
			sh := sc.Shell
			tc := terminal.New(terminal.Deps{Root: root, Home: &home, Platform: sc.Platform, Shell: &sh,
				Source: func() *terminal.Source { return src }, Logger: warns,
				WindowsPath: func(dir string, add bool) bool {
					winCalls = append(winCalls, []any{dir, add})
					return sc.WinPath == nil || *sc.WinPath
				},
				OnEnabled: func() { enabled++ }})
			for i, st := range sc.Steps {
				var out any
				switch st[0] {
				case "state":
					out = tc.State()
				case "refresh":
					tc.Refresh()
				default:
					var add *bool
					if len(st) > 2 {
						b := st[2].(bool)
						add = &b
					}
					r, err := tc.Set(st[1].(bool), add)
					if err != nil {
						t.Fatalf("step %d set: %v", i, err)
					}
					out = r
				}
				want := sc.Log[i]
				if got := normJSON(t, out, sb); !reflect.DeepEqual(got, want.Out) {
					t.Errorf("step %d %v out:\n got %v\nwant %v", i, st, got, want.Out)
				}
				if got := normJSON(t, fileTree(home), sb); !reflect.DeepEqual(got, want.Home) {
					t.Errorf("step %d %v home tree:%s", i, st, treeDiff(got, want.Home))
				}
				if got := normJSON(t, fileTree(root), sb); !reflect.DeepEqual(got, want.Root) {
					t.Errorf("step %d %v root tree:%s", i, st, treeDiff(got, want.Root))
				}
			}
			if winCalls == nil {
				winCalls = []any{}
			}
			if got := normJSON(t, winCalls, sb); !reflect.DeepEqual(got, sc.WinCalls) {
				t.Errorf("windowsPath calls %v want %v", got, sc.WinCalls)
			}
			if got := normJSON(t, warns.w, sb); !(len(warns.w) == 0 && reflect.DeepEqual(sc.Warns, []any{})) && !reflect.DeepEqual(got, sc.Warns) {
				t.Errorf("warns %v want %v", got, sc.Warns)
			}
			if enabled != sc.EnabledCalls {
				t.Errorf("onEnabled calls %d want %d", enabled, sc.EnabledCalls)
			}
		})
	}
	_ = json.Valid
}
