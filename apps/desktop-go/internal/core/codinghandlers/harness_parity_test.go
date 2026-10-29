package codinghandlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 回放 scripts/parity/record-b7-coding.mjs 的 golden：经 Router 会话调用 harness.* 过程，
// 比对线上值 / 错误 {code, message}。

type nopLogger struct{}

func (nopLogger) Info(string, any) {}
func (nopLogger) Warn(string, any) {}

type nopPorts struct{}

func (nopPorts) PickDirectory(string, bool, string) *string { return nil }
func (nopPorts) AnyFocused() bool                           { return false }

var (
	uuidRe   = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	timeKeys = map[string]bool{"ts": true, "at": true, "expiresAt": true, "startedAt": true, "durationMs": true,
		"updatedAt": true, "createdAt": true, "timestamp": true, "lastActiveAt": true}
)

func norm(v any, tmp string) any {
	switch x := v.(type) {
	case string:
		return uuidRe.ReplaceAllString(strings.ReplaceAll(x, tmp, "<T>"), "<U>")
	case []any:
		for i := range x {
			x[i] = norm(x[i], tmp)
		}
		return x
	case map[string]any:
		delete(x, "bins")
		for k, e := range x {
			if _, num := e.(float64); num && timeKeys[k] {
				x[k] = "<N>"
			} else {
				x[k] = norm(e, tmp)
			}
		}
		return x
	}
	return v
}

type gcase struct {
	Name  string  `json:"name"`
	Steps [][]any `json:"steps"`
}

type scase struct {
	Name      string  `json:"name"`
	NoHarness bool    `json:"noHarness"`
	Calls     [][]any `json:"calls"`
}

func repoFile(t *testing.T, rel string) string {
	wd, _ := os.Getwd()
	for d := wd; d != filepath.Dir(d); d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, rel)); err == nil {
			return filepath.Join(d, rel)
		}
	}
	t.Fatalf("%s not found", rel)
	return ""
}

func sub(v any, ids []string, work, tmp string) any {
	switch x := v.(type) {
	case string:
		if len(x) > 1 && x[0] == '$' && x[1] >= '0' && x[1] <= '9' {
			var n int
			fmt.Sscanf(x[1:], "%d", &n)
			if n < len(ids) {
				return ids[n]
			}
			return x
		}
		return strings.ReplaceAll(strings.ReplaceAll(x, "$W", work), "$T", tmp)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = sub(e, ids, work, tmp)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = sub(e, ids, work, tmp)
		}
		return out
	}
	return v
}

func runCase(t *testing.T, c scase) []any {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	work := filepath.Join(tmp, "work")
	_ = os.MkdirAll(work, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	var o *harness.Orchestrator
	if !c.NoHarness {
		idle := 0.0
		o = jsrt.Call(func() *harness.Orchestrator {
			return harness.New(harness.Deps{Root: filepath.Join(tmp, "harness"), Home: tmp,
				DefaultCwd: filepath.Join(tmp, "docs", "nomi"), LegacyDefaultCwd: filepath.Join(tmp, "docs"),
				Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
		})
		defer jsrt.Run(func() { o.FlushPersist(); o.Dispose() })
	}
	r := contract.NewRouter()
	RegisterHarness(r, func() *harness.Orchestrator { return o })
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) {
		if f.T == "res" || f.T == "err" {
			ch <- f
		}
	})
	defer s.Close()
	var ids []string
	steps := []any{}
	for i, call := range c.Calls {
		name := call[0].(string)
		in, _ := json.Marshal(sub(call[1], ids, work, tmp))
		fr, _ := json.Marshal(contract.ClientFrame{T: "req", ID: fmt.Sprint(i), Kind: "call", Name: name, Input: in})
		s.Handle(fr)
		var f contract.ServerFrame
		select {
		case f = <-ch:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: timeout", name)
		}
		var r any
		if f.Error != nil {
			r = map[string]any{"err": map[string]any{"code": f.Error.Code, "message": f.Error.Message}}
		} else {
			b, _ := json.Marshal(f.Output)
			var v any
			_ = json.Unmarshal(b, &v)
			if m, ok := v.(map[string]any); ok && name == "harness.tabCreate" {
				ids = append(ids, m["id"].(string))
			}
			r = map[string]any{"ok": v}
		}
		steps = append(steps, []any{name, r})
	}
	return norm(steps, tmp).([]any)
}

func loadAll(t *testing.T) ([]scase, []gcase) {
	var sc struct{ Cases []scase }
	b, err := os.ReadFile(repoFile(t, "scripts/parity/b7-coding-scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &sc); err != nil {
		t.Fatal(err)
	}
	p, _ := paritytest.Golden(t, "b7_coding_harness.json", "testdata/b7_coding_harness.json")
	var g struct{ Cases []gcase }
	b, err = os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) != len(sc.Cases) {
		t.Fatalf("golden has %d cases, scenarios %d", len(g.Cases), len(sc.Cases))
	}
	return sc.Cases, g.Cases
}

func asAny(v any) any {
	b, _ := json.Marshal(v)
	var x any
	_ = json.Unmarshal(b, &x)
	return x
}

func diff(want, got []any) string {
	if len(want) != len(got) {
		return fmt.Sprintf("steps %d vs %d", len(want), len(got))
	}
	for i := range want {
		if !reflect.DeepEqual(want[i], got[i]) {
			w, _ := json.Marshal(want[i])
			g, _ := json.Marshal(got[i])
			return fmt.Sprintf("step %d:\n want %s\n got  %s", i, w, g)
		}
	}
	return ""
}

func TestHarnessProceduresGolden(t *testing.T) {
	sc, g := loadAll(t)
	for i, c := range sc {
		t.Run(c.Name, func(t *testing.T) {
			want := asAny(g[i].Steps).([]any)
			if d := diff(want, runCase(t, c)); d != "" {
				t.Fatal(d)
			}
		})
	}
}

// 变异检查：改动 golden 的一步（值 / 错误码 / 删掉一步）比对必须失败。
func TestHarnessProceduresGoldenMutation(t *testing.T) {
	sc, g := loadAll(t)
	for i, c := range sc {
		got := runCase(t, c)
		want := asAny(g[i].Steps).([]any)
		if d := diff(want, got); d != "" {
			t.Fatalf("%s: baseline mismatch: %s", c.Name, d)
		}
		muts := []func([]any) []any{
			func(s []any) []any { return s[:len(s)-1] },
			func(s []any) []any {
				s[0].([]any)[1] = map[string]any{"ok": "mutated"}
				return s
			},
			func(s []any) []any {
				last := s[len(s)-1].([]any)
				if m, ok := last[1].(map[string]any)["err"].(map[string]any); ok {
					m["code"] = "MUTATED"
				} else {
					last[1] = map[string]any{"err": map[string]any{"code": "X", "message": "x"}}
				}
				return s
			},
		}
		for j, m := range muts {
			if diff(m(asAny(want).([]any)), got) == "" {
				t.Errorf("%s: mutation %d not detected", c.Name, j)
			}
		}
	}
}
