package drivers

import (
	"encoding/json"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

type driverScenario struct {
	ID     string            `json:"id"`
	Driver string            `json:"driver"`
	Mapper string            `json:"mapper"`
	Bin    string            `json:"bin"`
	Args   []string          `json:"args"`
	Env    map[string]string `json:"env"`
	Perm   json.RawMessage   `json:"perm"`
	Steps  []struct {
		Op       string          `json:"op"`
		Text     string          `json:"text"`
		ResumeID string          `json:"resumeId"`
		Params   json.RawMessage `json:"params"`
	} `json:"steps"`
}

var volatile = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|acp-[0-9a-f]{8}`)

func norm(s string) string { return volatile.ReplaceAllString(s, "<id>") }

func parseObj(t *testing.T, raw []byte) *util.Obj {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	v, err := util.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return v.(*util.Obj)
}

// TestDriverParity 用 scripts/parity/record-b7-drivers.mjs 同一组场景驱动 mock CLI，逐条比对 Node 录下的事件与返回值。
func TestDriverParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		paritytest.SkipOrFail(t, "node not found")
	}
	root, _ := filepath.Abs("../../../../..")
	var scs []driverScenario
	b, err := os.ReadFile(filepath.Join(root, "scripts/parity/b7-driver-scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &scs); err != nil {
		t.Fatal(err)
	}
	var golden []struct {
		ID  string            `json:"id"`
		Log []json.RawMessage `json:"log"`
	}
	gp, _ := paritytest.Golden(t, "drivers.json", "testdata/drivers.json")
	b, _ = os.ReadFile(gp)
	if err := json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden) != len(scs) {
		t.Fatalf("golden %d scenarios, have %d", len(golden), len(scs))
	}
	total := 0
	for i, sc := range scs {
		got := runDriverScenario(t, node, root, sc)
		want := golden[i].Log
		if len(got) != len(want) {
			t.Errorf("%s: %d entries, want %d\n got=%v", sc.ID, len(got), len(want), got)
			continue
		}
		for j := range want {
			v, _ := util.Parse(want[j])
			w := norm(util.Stringify(v))
			if norm(got[j]) != w {
				t.Errorf("%s[%d]:\n got %s\nwant %s", sc.ID, j, norm(got[j]), w)
			}
			total++
		}
	}
	t.Logf("driver parity: %d scenarios, %d entries", len(scs), total)
}

func runDriverScenario(t *testing.T, node, root string, sc driverScenario) []string {
	var log []string
	push := func(o *util.Obj) { log = append(log, util.Stringify(o)) }
	env := []string{"PATH=" + os.Getenv("PATH")}
	for k, v := range sc.Env {
		env = append(env, k+"="+v)
	}
	perm := parseObj(t, sc.Perm)
	jsrt.Run(func() {
		n := 0
		newID := func() string { n++; return "id-" + util.FormatNumber(float64(n)) }
		pc := nodeproc.Spawn(node, append([]string{filepath.Join(root, "packages/core/scripts/mock-cli", sc.Bin)}, sc.Args...), nodeproc.Options{Cwd: root, Env: env})
		child := clisdk.ProcChild{Child: pc}
		exited := jsrt.NewPromise[struct{}]()
		pc.OnClose(func(*int, string) { exited.Resolve(struct{}{}) })
		type drv interface {
			On(func(SessionEvent)) func()
			RespondPermission(string, Json) bool
			Start(clisdk.StartOptions) *jsrt.Promise[StartResult]
			Send(TurnInput) *jsrt.Promise[TurnResult]
			Close() *jsrt.Promise[struct{}]
		}
		var d drv
		var app *AppServerDriver
		if sc.Driver == "appserver" {
			app = NewAppServerDriver(AppServerDriverOptions{Child: child, NewID: newID, MapItem: func(phase string, item Json) []Json {
				if m := CodexExecItem(item); m != nil {
					return []Json{O("type", "status", "kind", phase, "text", util.Stringify(m))}
				}
				return nil
			}})
			d = app
		} else {
			d = NewAcpDriver(AcpDriverOptions{Child: child, NewID: newID})
		}
		ended := jsrt.NewPromise[struct{}]()
		d.On(func(e SessionEvent) {
			if e == nil {
				ended.Resolve(struct{}{})
			}
		})
		d.On(func(e SessionEvent) {
			if e == nil {
				log = append(log, "{}") // Node END 是 Symbol：JSON.stringify({ev: Symbol}) = {}
				return
			}
			push(O("ev", e))
			if e.Get("kind") == "permission" && perm != nil {
				d.RespondPermission(e.Get("id").(string), perm)
			}
		})
		for _, st := range sc.Steps {
			var r any
			var err error
			switch st.Op {
			case "start":
				o := clisdk.StartOptions{Cwd: root}
				if st.ResumeID != "" {
					o.ResumeID = &st.ResumeID
				}
				r, err = jsrt.Await(d.Start(o))
			case "ensureThread":
				r, err = jsrt.Await(app.EnsureThread(root))
			case "send":
				in := TurnInput{Text: st.Text, Params: parseObj(t, st.Params)}
				r, err = jsrt.Await(d.Send(in))
			case "close":
				jsrt.Await(d.Close())
				r = "<undefined>"
				timeout := jsrt.NewPromise[struct{}]()
				tm := jsrt.SetTimeout(5*time.Second, func() { timeout.Resolve(struct{}{}) })
				for !exited.Settled() && !timeout.Settled() {
					jsrt.Sleep(10 * time.Millisecond)
				}
				jsrt.ClearTimeout(tm)
			}
			if err != nil {
				push(O("op", st.Op, "err", err.Error()))
			} else {
				push(O("op", st.Op, "ok", r))
			}
		}
		for i := 0; i < 300 && !ended.Settled(); i++ {
			jsrt.Sleep(10 * time.Millisecond)
		}
	})
	return log
}
