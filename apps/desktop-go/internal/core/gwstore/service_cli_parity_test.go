package gwstore

// 编程助手方法 golden（scripts/parity/record-gwcli.mjs；NOMI_LIVE_GOLDENS 设置时用本平台现场录制）。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
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

// udSub mirrors the recorder: replace the data dir at every escape depth, deepest first,
// since on Windows a path nested in a quoted CLI arg is backslash-escaped twice.
func udSub(s, ud string) string {
	for k := 3; k >= 0; k-- {
		s = strings.ReplaceAll(s, strings.ReplaceAll(ud, `\`, strings.Repeat(`\`, 1<<k)), "<UD>")
	}
	return s
}

func cliTree(dir string) map[string]string {
	out := map[string]string{}
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		out[filepath.ToSlash(rel)] = udSub(string(b), dir)
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
	if len(g.Scenarios) != 5 {
		t.Fatalf("scenarios=%d", len(g.Scenarios))
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			fixRandom(t)
			models.SetCatalogOverlay(nil)
			t.Cleanup(func() { models.SetCatalogOverlay(nil) })
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

			stub := newHelperStub(t)
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
				case "applyModelsDataN":
					<-s.ApplyModelsData(cliModelsAPI(int(arg(0).(float64))))
				case "hasCatalogSync":
					res = s.HasCatalogSync()
				case "modelMetaOf":
					if m := s.ModelMetaOf(str(0), nil); m != nil {
						res = m.Obj()
					}
				case "storeProvider":
					s.Store.UpsertProvider(obj(0))
				case "confirmPrivateHost":
					err = s.ConfirmPrivateHost(str(0))
				case "writeSessions":
					_ = os.MkdirAll(filepath.Join(ud, "gateway"), 0o755)
					_ = os.WriteFile(filepath.Join(ud, "gateway", "sessions.json"), []byte(str(0)), 0o644)
				case "servedSession":
					res = s.ServedSession(str(0), str(1))
				case "servedSessionRef":
					if r := s.ServedSessionRef(str(0), str(1)); r != "" {
						res = r
					}
				case "helperRoute":
					if r := s.HelperRoute(str(0), str(1)); r != nil {
						res = r.Obj()
					}
				case "endpoint":
					if e := s.Endpoint(str(0)); e != nil {
						res = u.NewObj("url", e.URL, "token", e.Token)
					}
				case "stubListen":
					child.msg(server.WorkerOutbound{Type: "listening", Port: stub.port, URL: fmt.Sprintf("http://127.0.0.1:%d", stub.port)})
				case "helperComplete":
					ms := []HelperMessage{}
					l, _ := arg(1).([]any)
					for _, x := range l {
						o := x.(*u.Obj)
						ms = append(ms, HelperMessage{Role: u.JSString(o.Get("role")), Content: u.JSString(o.Get("content"))})
					}
					stub.reset()
					v, e := s.HelperComplete(context.Background(), str(0), ms)
					r := u.NewObj()
					if e != nil {
						r.Set("error", e.Error())
					} else {
						r.Set("value", v)
					}
					res = r.Set("req", stub.get())
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
				gs := udSub(cliCanon(got), ud)
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

// cliModelsAPI = record-gwcli.mjs modelsApi(n)
func cliModelsAPI(n int) any {
	ms := u.NewObj()
	for i := 0; i < n; i++ {
		in := []any{"text"}
		if i%3 == 0 {
			in = []any{"text", "image"}
		}
		ms.Set(fmt.Sprintf("m-%03d", i), u.NewObj("id", fmt.Sprintf("m-%d", i), "name", fmt.Sprintf("M %d", i), "reasoning", i%2 == 0,
			"modalities", u.NewObj("input", in), "limit", u.NewObj("context", float64(100000+i*1000), "output", float64(4096+i))))
	}
	ms.Set("plain", u.NewObj("id", "plain", "name", "Plain", "limit", u.NewObj("context", float64(777000), "output", float64(33000))))
	ms.Set("embed", u.NewObj("id", "embed", "type", "embedding", "limit", u.NewObj("context", float64(8000))))
	return u.NewObj("openai", u.NewObj("models", ms))
}

// helperStub = record-gwcli.mjs 的 STUB 上游桩
type helperStub struct {
	port int
	mu   sync.Mutex
	last *u.Obj
}

var helperStubResp = map[string]struct {
	st   int
	text string
}{
	"ok":         {200, `{"choices":[{"message":{"content":"héllo 😀 <&>"}}]}`},
	"nonstr":     {200, `{"choices":[{"message":{"content":5}}]}`},
	"bom":        {200, "\ufeff" + `{"choices":[{"message":{"content":"b"}}]}`},
	"notjson":    {200, "nope"},
	"objchoices": {200, `{"choices":{"0":{"message":{"content":"obj"}}}}`},
	"nochoices":  {200, `{"x":1}`},
	"nullj":      {200, "null"},
	"boom":       {503, strings.Repeat("e", 499) + "😀tail"},
	"short":      {401, "bad key"},
}

func newHelperStub(t *testing.T) *helperStub {
	h := &helperStub{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.port = ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		h.last = u.NewObj("method", r.Method, "url", r.URL.RequestURI(), "authorization", r.Header.Get("authorization"),
			"contentType", r.Header.Get("content-type"), "body", string(b))
		h.mu.Unlock()
		model := ""
		if j, ok := jsonParse(b).(*u.Obj); ok {
			model, _ = j.Get("model").(string)
		}
		resp, ok := helperStubResp[model]
		if !ok {
			resp.st, resp.text = 404, "no such model"
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(resp.st)
		_, _ = io.WriteString(w, resp.text)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return h
}

func (h *helperStub) reset() { h.mu.Lock(); h.last = nil; h.mu.Unlock() }
func (h *helperStub) get() any {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.last == nil {
		return nil
	}
	return h.last
}
