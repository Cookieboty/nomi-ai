package gwstore

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 同一组数值见 apps/desktop-electron/internal/core/tests/unit/gateway/nomiContext.test.ts
func TestNomiContextBudget(t *testing.T) {
	for _, c := range [][5]float64{
		{200_000, 64_000, 32_000, 168_000, 159_600},
		{8_192, 32_000, 2_048, 6_144, 5_836},
		{1_000_000, 0, 32_000, 968_000, 919_600},
		{128_000, 8_192, 8_192, 119_808, 113_817},
	} {
		w, r, b, ca := NomiContextBudget(c[0], c[1])
		if w != c[0] || r != c[2] || b != c[3] || ca != c[4] {
			t.Errorf("ctx %v maxOutput %v: got %v %v %v %v", c[0], c[1], w, r, b, ca)
		}
	}
}

func TestApplyNomiContext(t *testing.T) {
	info := u.NewObj("budget", float64(168_000))
	var roles []string
	o := map[string]any{"messages": []any{}}
	ApplyNomiContext(o, "agentStream", func(r string) *u.Obj { roles = append(roles, r); return info })
	ctx, _ := o["context"].(map[string]any)
	if ctx["maxTokens"] != float64(168_000) || ctx["maxMessages"] != float64(NomiMaxMessages) || len(roles) != 1 || roles[0] != "agent-tools" {
		t.Fatalf("got %v roles %v", o["context"], roles)
	}
	explicit := map[string]any{"context": false}
	ApplyNomiContext(explicit, "stream", func(string) *u.Obj { return info })
	if explicit["context"] != false {
		t.Fatal("explicit context overwritten")
	}
	pinned := map[string]any{"provider": "x"}
	ApplyNomiContext(pinned, "stream", func(string) *u.Obj { return info })
	if _, ok := pinned["context"]; ok {
		t.Fatal("pinned provider got a budget")
	}
	none := map[string]any{}
	ApplyNomiContext(none, "stream", func(string) *u.Obj { return nil })
	if _, ok := none["context"]; ok {
		t.Fatal("no model but got a budget")
	}
	if ChatRoleOf("summary", "agentStream") != "summary" || ChatRoleOf(nil, "agent") != "agent-tools" || ChatRoleOf("bogus", "stream") != "chat" {
		t.Fatal("ChatRoleOf")
	}
}
