package desktop

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// D-B5-10：prepareChat 与 Node（scripts/parity/record-b5-prepchat.mjs）逐场景一致
type prepScenario struct {
	Name        string               `json:"name"`
	Method      string               `json:"method"`
	Options     json.RawMessage      `json:"options"`
	Workspaces  map[string]string    `json:"workspaces"`
	AutoApprove bool                 `json:"autoApprove"`
	Providers   map[string]*Provider `json:"providers"`
	Verdicts    map[string]string    `json:"verdicts"`
}

func runPrep(t *testing.T, sc prepScenario, mutate func(*ChatPrep)) map[string]any {
	var calls []any
	c := ChatPrep{
		Broker: WorkspaceBroker{
			WorkspaceOf: func(cwd any) string {
				calls = append(calls, map[string]any{"op": "workspaceOf", "cwd": cwd})
				if s, ok := cwd.(string); ok {
					return sc.Workspaces[s]
				}
				return ""
			},
			AutoApprove: func() bool { return sc.AutoApprove },
		},
		ProviderFor: func(r Role) *Provider { return sc.Providers[r] },
		CheckSend: func(p *Provider, _ context.Context, what string) string {
			calls = append(calls, map[string]any{"op": "checkSend", "id": p.ID, "what": what})
			if p.Local {
				return ""
			}
			return sc.Verdicts[p.ID]
		},
	}
	if mutate != nil {
		mutate(&c)
	}
	var opts map[string]any
	if err := json.Unmarshal(sc.Options, &opts); err != nil {
		t.Fatal(err)
	}
	var errv any
	if err := c.PrepareChat(opts, sc.Method, nil); err != nil {
		errv = err.Error()
	}
	if calls == nil {
		calls = []any{}
	}
	return canon(t, map[string]any{"name": sc.Name, "options": opts, "error": errv, "calls": calls})
}

func canon(t *testing.T, v any) map[string]any {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func loadPrep(t *testing.T) ([]prepScenario, []map[string]any) {
	var spec struct{ Scenarios []prepScenario }
	b, err := os.ReadFile(paritytest.RepoPath("scripts/parity/b5-prepchat-scenarios.json"))
	if err != nil {
		paritytest.SkipOrFail(t, "scenarios:", err)
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatal(err)
	}
	p, _ := paritytest.Golden(t, "b5_prepchat.json", "testdata/b5_prepchat.json")
	gb, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var want []map[string]any
	if err := json.Unmarshal(gb, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(spec.Scenarios) {
		t.Fatalf("golden %d vs scenarios %d", len(want), len(spec.Scenarios))
	}
	return spec.Scenarios, want
}

func TestPrepareChatParity(t *testing.T) {
	scs, want := loadPrep(t)
	for i, sc := range scs {
		got := runPrep(t, sc, nil)
		if !reflect.DeepEqual(got, want[i]) {
			g, _ := json.MarshalIndent(got, "", " ")
			w, _ := json.MarshalIndent(want[i], "", " ")
			t.Errorf("%s:\n got %s\nwant %s", sc.Name, g, w)
		}
	}
}

// 变异：比较必须能抓到偏差
func TestPrepareChatParityMutation(t *testing.T) {
	scs, want := loadPrep(t)
	muts := map[string]func(*ChatPrep){
		"autoApprove-flipped": func(c *ChatPrep) { c.Broker.AutoApprove = func() bool { return true } },
		"role-chat-only": func(c *ChatPrep) {
			pf := c.ProviderFor
			c.ProviderFor = func(Role) *Provider { return pf("chat") }
		},
		"verdict-ignored": func(c *ChatPrep) {
			c.CheckSend = func(*Provider, context.Context, string) string { return "" }
		},
		"workspace-uppercased": func(c *ChatPrep) {
			w := c.Broker.WorkspaceOf
			c.Broker.WorkspaceOf = func(cwd any) string { return strings.ToUpper(w(cwd)) }
		},
	}
	for name, m := range muts {
		caught := false
		for i, sc := range scs {
			if !reflect.DeepEqual(runPrep(t, sc, m), want[i]) {
				caught = true
				break
			}
		}
		if !caught {
			t.Errorf("mutation %s not caught", name)
		}
	}
}
