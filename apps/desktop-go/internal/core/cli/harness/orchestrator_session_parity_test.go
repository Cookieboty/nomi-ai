package harness

// b7o：Orchestrator 各 CLI 会话段的 Node golden 回放（scripts/parity/record-b7-orch.mjs）。
// 场景表 scripts/parity/b7-orch-scenarios.json 与录制器共用；比对 结果/错误文案/事件类型序列/标签状态。

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

var orchTimeKeys = map[string]bool{"ts": true, "at": true, "expiresAt": true, "startedAt": true, "durationMs": true, "updatedAt": true, "createdAt": true}

func orchNorm(v any, tmp string) any {
	switch x := v.(type) {
	case string:
		return uuidRe.ReplaceAllString(strings.ReplaceAll(x, tmp, "<T>"), "<U>")
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = orchNorm(e, tmp)
		}
		return out
	case []*util.Obj:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = orchNorm(e, tmp)
		}
		return out
	case *util.Obj:
		if x == nil {
			return nil
		}
		o := util.NewObj()
		for _, k := range x.Keys() {
			e := x.Get(k)
			if _, num := e.(float64); num && orchTimeKeys[k] {
				o.Set(k, "<N>")
				continue
			}
			if _, num := e.(int); num && orchTimeKeys[k] {
				o.Set(k, "<N>")
				continue
			}
			o.Set(k, orchNorm(e, tmp))
		}
		return o
	}
	return v
}

type nopLogger struct{}

func (nopLogger) Info(string, any) {}
func (nopLogger) Warn(string, any) {}

type nopPorts struct{}

func (nopPorts) PickDirectory(string, bool, string) *string { return nil }
func (nopPorts) AnyFocused() bool                           { return false }

func repoRoot(t *testing.T) string {
	wd, _ := os.Getwd()
	for d := wd; d != filepath.Dir(d); d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "packages/core/scripts/mock-cli")); err == nil {
			return d
		}
	}
	t.Fatal("repo root not found")
	return ""
}

func loadOrchGolden(t *testing.T, live bool) []any {
	p := filepath.Join("testdata", "b7_orch_sessions.json")
	if live {
		p, _ = paritytest.Golden(t, "b7_orch_sessions.json", p)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return util.AsObj(v).Get("cases").([]any)
}

func loadOrchScenarios(t *testing.T) []any {
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "scripts/parity/b7-orch-scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, _ := util.Parse(b)
	return util.AsObj(v).Get("cases").([]any)
}

func runOrchCase(t *testing.T, c *util.Obj) *util.Obj {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	cwd := filepath.Join(tmp, "work")
	_ = os.MkdirAll(cwd, 0o755)
	t.Setenv("NOMI_USE_MOCK_CLI", "1")
	if c.Has("env") {
		env := util.AsObj(c.Get("env"))
		for _, k := range env.Keys() {
			t.Setenv(k, env.Get(k).(string))
		}
	}
	grace, ctl, idle := 300.0, 2000.0, 0.0
	o := New(Deps{Root: filepath.Join(tmp, "harness"), Home: tmp, Logger: nopLogger{}, Ports: nopPorts{},
		GrokAcp: c.Get("grokAcp") == true, CodexAppServer: c.Get("codexAppServer") == true,
		ClaudeInterruptGraceMs: &grace, ClaudeControlTimeoutMs: &ctl, IdleReclaimMs: &idle})
	var evs []any
	for _, n := range []string{"event", "permission-needed"} {
		n := n
		o.events.On(n, func(p any) {
			var ty any
			if po := util.AsObj(p); po != nil {
				if e := util.AsObj(po.Get("event")); e != nil {
					ty = e.Get("type")
				}
			}
			evs = append(evs, []any{n, ty})
		})
	}
	mode := "default"
	if m, ok := c.Get("permissionMode").(string); ok {
		mode = m
	}
	tab := util.NewObj()
	tab.Set("id", "t1")
	tab.Set("title", "T")
	tab.Set("backend", c.Get("backend"))
	tab.Set("cwd", cwd)
	tab.Set("permissionMode", mode)
	tab.Set("cliSessionId", nil)
	tab.Set("messages", []any{})
	o.tabs.Set("t1", tab)
	var turns []any
	for _, pr := range c.Get("prompts").([]any) {
		prompt := pr.(string)
		ac := jsrt.NewAbortController()
		stop := make(chan struct{})
		if c.Get("cancel") == true {
			go func() {
				tk := time.NewTicker(20 * time.Millisecond)
				defer tk.Stop()
				for {
					select {
					case <-stop:
						return
					case <-tk.C:
					}
					done := make(chan bool, 1)
					jsrt.Go(func() {
						if l := o.live.claude["t1"]; l != nil && l.turn != nil {
							o.stopRequested["t1"] = true
							o.interruptClaudeTurn("t1", l, l.turn)
							done <- true
							return
						}
						done <- false
					})
					if <-done {
						return
					}
				}
			}()
		}
		p := jsrt.Call(func() (p *jsrt.Promise[*util.Obj]) {
			switch c.Get("backend") {
			case "claude":
				p = o.runClaude(tab, prompt, ac.Signal, nil, "")
			case "gemini":
				p = o.runAcp(tab, prompt, ac.Signal, nil)
			case "grok":
				p = o.runGrokTurn(tab, prompt, ac.Signal, nil)
			case "codex":
				p = o.runCodexTurn(tab, prompt, ac.Signal, []cli.NormalizedImage{}, nil)
			case "dsh":
				p = o.runDsh(tab, prompt)
			}
			return
		})
		v, err := jsrt.Block(p)
		close(stop)
		r := util.NewObj()
		if err != nil {
			r.Set("err", err.Error())
			var named interface{ Name() string }
			if errors.As(err, &named) && named.Name() != "Error" {
				r.Set("name", named.Name())
			}
		} else {
			ok := util.NewObj()
			for _, k := range []string{"text", "sessionId", "events", "textBreaks"} {
				if v.Has(k) {
					ok.Set(k, v.Get(k))
				}
			}
			r.Set("ok", ok)
			if s, _ := v.Get("sessionId").(string); s != "" {
				tab.Set("cliSessionId", s)
			}
		}
		delete(o.stopRequested, "t1")
		turns = append(turns, r)
	}
	jsrt.Run(func() {
		o.teardownClaudeLive("t1")
		o.teardownAcpLive("t1")
		o.teardownCodexLive("t1")
	})
	out := util.NewObj()
	out.Set("name", c.Get("name"))
	out.Set("turns", turns)
	if c.Get("cancel") != true {
		out.Set("evTypes", evs)
	}
	ts := util.NewObj()
	ts.Set("cliSessionId", tab.Get("cliSessionId"))
	ts.Set("permissionMode", tab.Get("permissionMode"))
	out.Set("tab", ts)
	return util.AsObj(orchNorm(out, tmp))
}

func TestOrchestratorSessionsGolden(t *testing.T) {
	golden := loadOrchGolden(t, true)
	scen := loadOrchScenarios(t)
	if len(golden) != len(scen) {
		t.Fatalf("golden %d cases vs scenarios %d — re-record", len(golden), len(scen))
	}
	t.Chdir(repoRoot(t)) // mock-cli 按 cwd 解析（detect.go，同 Node）
	for i, sc := range scen {
		c := util.AsObj(sc)
		want := util.Stringify(golden[i])
		t.Run(c.Get("name").(string), func(t *testing.T) {
			got := util.Stringify(runOrchCase(t, c))
			if got != want {
				t.Fatalf("mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

// 变异检查：golden 任一字段被改，逐字比对必须失败（防止比对器空转）。
func TestOrchestratorSessionsGoldenMutation(t *testing.T) {
	golden := loadOrchGolden(t, false)
	if len(golden) < 20 {
		t.Fatalf("expected ≥20 recorded cases, got %d", len(golden))
	}
	for i, g := range golden {
		orig := util.Stringify(g)
		m := util.AsObj(orchNorm(g, "\x00")) // 深拷贝
		turns := m.Get("turns").([]any)
		t0 := util.AsObj(turns[0])
		if t0.Has("ok") {
			util.AsObj(t0.Get("ok")).Set("text", "MUTATED")
		} else {
			t0.Set("err", "MUTATED")
		}
		if util.Stringify(m) == orig {
			t.Fatalf("case %d: mutation not detected", i)
		}
		if util.Stringify(orchNorm(g, "\x00")) != orig {
			t.Fatalf("case %d: normaliser not idempotent on golden", i)
		}
	}
}
