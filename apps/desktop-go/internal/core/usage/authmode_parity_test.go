package usage

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type amGolden struct {
	Parse []struct {
		T        string  `json:"t"`
		Claude   *string `json:"claude"`
		Ident    string `json:"ident"`
		SoClaude bool    `json:"soClaude"`
		SoCodex  bool    `json:"soCodex"`
		Codex    *string `json:"codex"`
	} `json:"parse"`
	Cfg []struct {
		Files        map[string]any    `json:"files"`
		Env          map[string]string `json:"env"`
		Docs         string            `json:"docs"`
		Custom       bool              `json:"custom"`
		Oauth        *bool             `json:"oauth"`
		Claude       *string           `json:"claude"`
		Codex        *string           `json:"codex"`
		GrokManaged  bool              `json:"grokManaged"`
		GrokCustom   bool              `json:"grokCustom"`
		Grok         *string           `json:"grok"`
		GrokPresence bool              `json:"grokPresence"`
	} `json:"cfg"`
	Scen []struct {
		Name    string                       `json:"name"`
		Files   map[string]any               `json:"files"`
		Env     map[string]string            `json:"env"`
		Salt    string                       `json:"salt"`
		Run     map[string]*string           `json:"run"`
		Runs    map[string][]*string         `json:"runs"`
		Sub     []string                     `json:"sub"`
		Restore json.RawMessage              `json:"restore"`
		EnvFor  map[string]map[string]string `json:"envFor"`
		Ops     [][]any                      `json:"ops"`
		Out     []any                        `json:"out"`
		Calls   []string                     `json:"calls"`
	} `json:"scen"`
	Apply []struct {
		Entries  []QuotaEntry      `json:"entries"`
		Modes    map[string]string `json:"modes"`
		Detected []string          `json:"detected"`
	} `json:"apply"`
	ApplyOut []string `json:"applyOut"`
}

func ns(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func amWriteFiles(t *testing.T, home string, files map[string]any) {
	for rel, c := range files {
		p := filepath.Join(home, filepath.FromSlash(rel))
		if s, ok := c.(string); ok {
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
				t.Fatal(err)
			}
		} else {
			_ = os.MkdirAll(p, 0o755)
		}
	}
}

func amEnv(home string, env map[string]string, order []string) *util.Obj {
	o := util.NewObj()
	for _, k := range order {
		v := env[k]
		if strings.HasPrefix(v, "~/") {
			v = filepath.Join(home, v[2:])
		}
		o.Set(k, v)
	}
	return o
}

func keysOf[V any](m map[string]V) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}

func loadAMGolden(t *testing.T) amGolden {
	b, err := os.ReadFile("testdata/usage-authmode.json")
	if err != nil {
		t.Fatal(err)
	}
	var g amGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestAuthModeParityParse(t *testing.T) {
	g := loadAMGolden(t)
	for i, c := range g.Parse {
		if got := ParseClaudeAuthStatus(c.T); got != ns(c.Claude) {
			t.Errorf("%d claude %q want %v", i, got, ns(c.Claude))
		}
		id := ParseClaudeIdentity(c.T, "salt-1")
		o := util.NewObj()
		if id.FP != nil {
			o.Set("fp", *id.FP)
		} else {
			o.Set("fp", nil)
		}
		if id.Plan != "" {
			o.Set("plan", id.Plan)
		}
		if got := util.Stringify(o); got != c.Ident {
			t.Errorf("%d ident %s want %s", i, got, c.Ident)
		}
		if IsDefinitelySignedOut("claude", c.T) != c.SoClaude || IsDefinitelySignedOut("codex", c.T) != c.SoCodex {
			t.Errorf("%d signedOut", i)
		}
		if got := ParseCodexLoginStatus(c.T); got != ns(c.Codex) {
			t.Errorf("%d codex %q want %q", i, got, ns(c.Codex))
		}
	}
}

func TestAuthModeParityConfig(t *testing.T) {
	g := loadAMGolden(t)
	for i, c := range g.Cfg {
		home := t.TempDir()
		amWriteFiles(t, home, c.Files)
		env := amEnv(home, c.Env, keysOf(c.Env))
		docs := ReadClaudeSettingsDocs(home, env)
		if got := util.Stringify(docs); got != c.Docs {
			t.Errorf("%d docs %s want %s", i, got, c.Docs)
		}
		if HasCustomClaudeConfiguration(env, docs) != c.Custom {
			t.Errorf("%d custom", i)
		}
		op := ClaudeOAuthPresent(home, env)
		if (op == nil) != (c.Oauth == nil) || (op != nil && *op != *c.Oauth) {
			t.Errorf("%d oauth %v want %v", i, op, c.Oauth)
		}
		if ClaudeAuthFromConfig(home, env) != ns(c.Claude) || CodexAuthFromConfig(home, env) != ns(c.Codex) || GrokAuthFromConfig(home, env) != ns(c.Grok) {
			t.Errorf("%d fromConfig claude=%q codex=%q grok=%q", i, ClaudeAuthFromConfig(home, env), CodexAuthFromConfig(home, env), GrokAuthFromConfig(home, env))
		}
		if HasManagedGrokConfiguration(home, env) != c.GrokManaged || HasCustomGrokConfiguration(home, env) != c.GrokCustom || HasGrokLocalPresence(home, env) != c.GrokPresence {
			t.Errorf("%d grok flags", i)
		}
	}
}

func TestAuthModeParityDetector(t *testing.T) {
	g := loadAMGolden(t)
	for _, sc := range g.Scen {
		jsrt.Run(func() {
			home := t.TempDir()
			amWriteFiles(t, home, sc.Files)
			clock := 1_792_119_600_000.0
			runs := map[string]int{}
			calls := []string{}
			pick := func(k string) (string, bool) {
				calls = append(calls, k)
				var v *string
				if rs, ok := sc.Runs[k]; ok {
					runs[k]++
					if runs[k]-1 < len(rs) {
						v = rs[runs[k]-1]
					}
				} else {
					v = sc.Run[k]
				}
				if v == nil {
					return "", false
				}
				if *v == "THROW" {
					panic(errors.New("x"))
				}
				return *v, true
			}
			d := AuthDeps{
				Home: home, Env: amEnv(home, sc.Env, keysOf(sc.Env)), Now: func() float64 { return clock },
				Run:     func(k string) (string, bool) { return pick(k) },
				GrokRun: func() (string, bool) { return pick("grok") },
				HasSubscriptionData: func(id string) bool {
					for _, s := range sc.Sub {
						if s == id {
							return true
						}
					}
					return false
				},
			}
			if sc.Salt != "" {
				salt := sc.Salt
				d.Salt = func() string { return salt }
			}
			if sc.EnvFor != nil {
				d.EnvFor = func(id string) *util.Obj {
					if e, ok := sc.EnvFor[id]; ok {
						return amEnv(home, e, keysOf(e))
					}
					return nil
				}
			}
			det := NewAuthModeDetector(d)
			changes := 0
			det.SetOnKnownChange(func() { changes++ })
			if len(sc.Restore) > 0 && string(sc.Restore) != "null" {
				v, _ := util.Parse(sc.Restore)
				o := v.(*util.Obj)
				saved := map[string]AuthInfo{}
				for _, k := range o.Keys() {
					r := o.Get(k).(*util.Obj)
					ai := AuthInfo{Mode: r.Get("mode").(string)}
					if fp, ok := r.Get("fp").(string); ok {
						ai.FP = &fp
					}
					if p, ok := r.Get("plan").(string); ok {
						ai.Plan = p
					}
					saved[k] = ai
				}
				det.RestoreKnown(o.Keys(), saved)
			}
			out := []any{}
			for _, op := range sc.Ops {
				arg, _ := op[1:len(op):len(op)], 0
				s := func() string {
					if len(arg) == 0 {
						return ""
					}
					v, _ := arg[0].(string)
					return v
				}()
				switch op[0] {
				case "full":
					info, _ := jsrt.Await(det.DetectFull(s))
					out = append(out, util.Stringify(info.ToObj()))
				case "passive":
					out = append(out, util.Stringify(det.DetectPassive(s).ToObj()))
				case "snap":
					out = append(out, util.Stringify(det.KnownSnapshot()))
				case "tick":
					clock += arg[0].(float64)
					out = append(out, nil)
				case "invalidate":
					det.Invalidate(s)
					out = append(out, nil)
				case "forget":
					det.ForgetKnown(s)
					out = append(out, nil)
				}
				out = append(out, float64(changes))
			}
			gb, _ := json.Marshal(sc.Out)
			ob, _ := json.Marshal(out)
			if string(gb) != string(ob) {
				t.Errorf("%s\n got %s\nwant %s", sc.Name, ob, gb)
			}
			if strings.Join(calls, ",") != strings.Join(sc.Calls, ",") {
				t.Errorf("%s calls %v want %v", sc.Name, calls, sc.Calls)
			}
		})
	}
}

func TestAuthModeParityApply(t *testing.T) {
	g := loadAMGolden(t)
	for i, a := range g.Apply {
		det := map[string]bool{}
		for _, d := range a.Detected {
			det[d] = true
		}
		got := ApplyAuthModes(a.Entries, a.Modes, det)
		b, _ := json.Marshal(got)
		if string(b) != g.ApplyOut[i] {
			t.Errorf("%d\n got %s\nwant %s", i, b, g.ApplyOut[i])
		}
	}
}
