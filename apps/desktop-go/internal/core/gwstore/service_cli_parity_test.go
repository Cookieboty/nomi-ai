package gwstore

// 编程助手方法 golden（scripts/parity/record-gwcli.mjs；NOMI_LIVE_GOLDENS 设置时用本平台现场录制）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type cliChild struct {
	mu    sync.Mutex
	msg   func(server.WorkerOutbound)
	table *route.BindingTable
	sent  *[]any
	smu   *sync.Mutex
}

func (c *cliChild) PostMessage(m server.WorkerInbound) {
	if m.Binding == nil {
		return
	}
	c.smu.Lock()
	*c.sent = append(*c.sent, m.Binding.Type)
	c.smu.Unlock()
	ack := c.table.Handle(*m.Binding)
	go func() {
		c.mu.Lock()
		fn := c.msg
		c.mu.Unlock()
		if fn != nil {
			fn(server.WorkerOutbound{Type: ack.Type, Ack: &ack})
		}
	}()
}
func (c *cliChild) OnMessage(fn func(m server.WorkerOutbound)) {
	c.mu.Lock()
	c.msg = fn
	c.mu.Unlock()
}
func (c *cliChild) OnExit(func(int)) {}
func (c *cliChild) Kill() bool       { return true }

func cliTree(dir string) map[string]string {
	out := map[string]string{}
	esc := strings.ReplaceAll(dir, `\`, `\\`)
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		out[filepath.ToSlash(rel)] = strings.ReplaceAll(strings.ReplaceAll(string(b), esc, "<UD>"), dir, "<UD>")
		return nil
	})
	return out
}

var cliEnvKeys = []string{"HOME", "USERPROFILE", "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME"}

func TestServiceCliParity(t *testing.T) {
	p := filepath.Join("testdata", "gwcli.json")
	if d := os.Getenv("NOMI_LIVE_GOLDENS"); d != "" {
		p = filepath.Join(d, "gwcli.json")
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Scenarios []struct {
			Name  string            `json:"name"`
			Steps []json.RawMessage `json:"steps"`
			Files map[string]string `json:"files"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) != 3 {
		t.Fatalf("scenarios=%d", len(g.Scenarios))
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			fixRandom(t)
			ud, _ := filepath.EvalSymlinks(t.TempDir())
			home := filepath.Join(ud, "home")
			_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
			_ = os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
			_ = os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"), []byte(`{"models":[{"slug":"gpt-5","display_name":"GPT-5","base_instructions":"be nice","priority":9,"input_modalities":["text","image"],"supported_reasoning_levels":[{"effort":"low"}],"default_reasoning_level":"medium"}]}`), 0o644)
			_ = os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://evil.example.com"}}`), 0o644)
			for _, k := range cliEnvKeys {
				t.Setenv(k, "")
				os.Unsetenv(k)
			}
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)

			var sent []any
			var smu sync.Mutex
			var child *cliChild
			table := route.NewBindingTable()
			port := 18999
			s := NewService(filepath.Join(ud, "gateway"), fakeCipher{}, nil, nil)
			s.AttachRuntime(RuntimeDeps{
				Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{},
				EnvProviders: func() []EnvProvider {
					return []EnvProvider{{ID: "deepseek", Name: "DeepSeek (env)", Wire: "chat", URL: "https://api.deepseek.com/v1", Key: "sk-env-deepseek-123456", KeyEnv: "DEEPSEEK_API_KEY", Model: "deepseek-chat"}}
				},
				Fork: func() GatewayChild {
					child = &cliChild{table: table, sent: &sent, smu: &smu}
					return child
				},
			})
			if err := s.Init(); err != nil {
				t.Fatal(err)
			}
			s.Start()
			for i, rawStep := range sc.Steps {
				want, _ := jsonParse(rawStep).(*u.Obj)
				op := u.JSString(want.Get("op"))
				args, _ := want.Get("args").([]any)
				arg := func(i int) any {
					if i < len(args) {
						return args[i]
					}
					return nil
				}
				str := func(i int) string { s, _ := arg(i).(string); return s }
				obj := func(i int) *u.Obj { o, _ := arg(i).(*u.Obj); return o }
				clock += 1000
				smu.Lock()
				sent = []any{}
				smu.Unlock()
				var res any
				var err error
				switch op {
				case "cliDefaults":
					res = s.CliDefaults(str(0))
				case "cliModels":
					l := []any{}
					for _, m := range s.CliModels() {
						l = append(l, m)
					}
					res = l
				case "upsertProvider":
					res, err = s.UpsertProvider(obj(0))
				case "setAssignment":
					err = s.SetAssignmentFor(str(0), obj(1))
				case "resetToken":
					err = s.ResetTokenFor(str(0))
				case "cliLaunch":
					o := CliLaunchOpts{}
					if x := obj(3); x != nil {
						o.TabBound, _ = x.Get("tabBound").(bool)
						if b, ok := x.Get("longContext").(bool); ok {
							o.LongContext = &b
						}
					}
					l, e := s.CliLaunch(str(0), str(1), str(2), o)
					err = e
					if l != nil {
						res = l.Obj()
					}
				case "cliLaunchForTab":
					var lc *bool
					if b, ok := arg(4).(bool); ok {
						lc = &b
					}
					l, e := s.CliLaunchForTab(str(0), str(1), str(2), str(3), lc)
					err = e
					if l != nil {
						res = l.Obj()
					}
				case "releaseTab":
					gen := -1
					if f, ok := arg(2).(float64); ok {
						gen = int(f)
					}
					s.ReleaseTab(str(0), str(1), gen)
				case "releaseAgent":
					s.ReleaseAgent(str(0), str(1))
				case "officialEnv":
					res = s.OfficialEnv(obj(0))
				case "officialEnvTok":
					tk, _ := s.Store.ClientToken(str(1))
					res = s.OfficialEnv(obj(0).Clone().Set("T", "x "+tk+" y"))
				case "storeProvider":
					s.Store.UpsertProvider(obj(0))
				case "listen":
					child.msg(server.WorkerOutbound{Type: "listening", Port: 18999, URL: "http://127.0.0.1:18999"})
				default:
					t.Fatalf("op %s", op)
				}
				time.Sleep(5 * time.Millisecond)
				got := u.NewObj("op", want.Get("op"), "args", want.Get("args"))
				if err != nil {
					got.Set("error", err.Error())
				} else {
					got.Set("result", res)
				}
				smu.Lock()
				got.Set("status", s.Status().State).Set("sent", append([]any{}, sent...))
				smu.Unlock()
				gs := strings.ReplaceAll(strings.ReplaceAll(cliCanon(got), strings.ReplaceAll(ud, `\`, `\\`), "<UD>"), ud, "<UD>")
				if ws := cliCanon(want); gs != ws {
					t.Fatalf("step %d %s\n--- node\n%s\n--- go\n%s", i, op, ws, gs)
				}
			}
			s.Dispose()
			gotFiles := cliTree(ud)
			keys := []string{}
			for k := range sc.Files {
				keys = append(keys, k)
			}
			for k := range gotFiles {
				if _, ok := sc.Files[k]; !ok {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			for _, k := range keys {
				if sc.Files[k] != gotFiles[k] {
					t.Errorf("file %s differs\n--- node\n%s\n--- go\n%s", k, sc.Files[k], gotFiles[k])
				}
			}
		})
	}
}

func jsonParse(b []byte) any { v, _ := u.Parse(b); return v }

func cliCanon(v any) string {
	p, _ := u.ParseString(u.Stringify(v))
	return u.Stringify(p)
}
