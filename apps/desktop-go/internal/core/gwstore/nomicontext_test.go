package gwstore

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 各模型窗口下的预算数值
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

func TestApplyContextTier(t *testing.T) {
	if got := ApplyContextTier(1_000_000, 0); got != 1_000_000 {
		t.Fatalf("no cap: %v", got)
	}
	if got := ApplyContextTier(1_000_000, ContextTier256k); got != ContextTier256k {
		t.Fatalf("256k cap: %v", got)
	}
	if got := ApplyContextTier(163_840, ContextTier256k); got != 163_840 {
		t.Fatalf("smaller than cap: %v", got)
	}
	if got := ApplyContextTier(200_000, ContextTier128k); got != ContextTier128k {
		t.Fatalf("128k cap: %v", got)
	}
	if AllowedContextTier(1) || !AllowedContextTier(ContextTier200k) {
		t.Fatal("allowed tiers")
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

func TestExtraLongContextAndApplyWith(t *testing.T) {
	if got := ExtraLongContext(map[string]any{}); got != nil {
		t.Fatalf("missing extra: %v", *got)
	}
	if got := ExtraLongContext(map[string]any{"extra": map[string]any{"longContext": "yes"}}); got != nil {
		t.Fatalf("non-bool longContext: %v", *got)
	}
	if got := ExtraLongContext(map[string]any{"extra": map[string]any{"longContext": true}}); got == nil || !*got {
		t.Fatalf("expected true, got %v", got)
	}
	if got := ExtraLongContext(map[string]any{"extra": map[string]any{"longContext": false}}); got == nil || *got {
		t.Fatalf("expected false, got %v", got)
	}

	var gotRole string
	var gotLong *bool
	o := map[string]any{
		"messages": []any{},
		"extra":    map[string]any{"longContext": true},
	}
	ApplyNomiContextWith(o, "agentStream", func(r string, lc *bool) *u.Obj {
		gotRole = r
		gotLong = lc
		return u.NewObj("budget", float64(900_000))
	})
	if gotRole != "agent-tools" || gotLong == nil || !*gotLong {
		t.Fatalf("forwarded role=%q long=%v", gotRole, gotLong)
	}
	ctx, _ := o["context"].(map[string]any)
	if ctx["maxTokens"] != float64(900_000) {
		t.Fatalf("context budget = %v", ctx["maxTokens"])
	}
}

func TestServiceNomiContextWithLongContext(t *testing.T) {
	dir := t.TempDir()
	s := NewServiceForUserData(dir, nil, nil)
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Env: map[string]string{},
		Fork: func() GatewayChild { return &syncChild{} }})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Dispose()

	// deepseek-v4.1-flash 在目录里分档：standard=262144, context=1048576
	saved, err := s.UpsertProvider(mustObj(t, `{
		"name":"MAAS","urls":{"chat":"https://maas.example.com/v1"},
		"newKeys":[{"value":"sk-test-1234567890"}],
		"models":[{"id":"deepseek-v4.1-flash","enabled":true}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := saved.Get("id").(string)
	if err := s.SetAssignment("nomi", mustObj(t, `{"models":{"main":"`+pid+`/deepseek-v4.1-flash"}}`)); err != nil {
		t.Fatal(err)
	}

	if got := s.NomiContextWith("chat", nil); got == nil || got.Get("window") != float64(262_144) {
		t.Fatalf("default window = %v", got)
	}
	tr, fl := true, false
	if got := s.NomiContextWith("chat", &tr); got == nil || got.Get("window") != float64(1_048_576) {
		t.Fatalf("longContext=true window = %v", got)
	}
	if got := s.NomiContextWith("chat", &fl); got == nil || got.Get("window") != float64(262_144) {
		t.Fatalf("longContext=false window = %v", got)
	}

	// 模型默认开启长上下文时，nil 跟随默认(1M)，false 仍强制回标准窗口(262144)
	if _, err := s.UpsertProvider(mustObj(t, `{
		"id":"`+pid+`","name":"MAAS","urls":{"chat":"https://maas.example.com/v1"},
		"models":[{"id":"deepseek-v4.1-flash","enabled":true,"longContext":true}]
	}`)); err != nil {
		t.Fatal(err)
	}
	if got := s.NomiContextWith("chat", nil); got == nil || got.Get("window") != float64(1_048_576) {
		t.Fatalf("model default long window = %v", got)
	}
	if got := s.NomiContextWith("chat", &fl); got == nil || got.Get("window") != float64(262_144) {
		t.Fatalf("override false over default = %v", got)
	}

	// 即使开启长上下文，仍受全局 contextTier 上限约束
	if _, err := s.SetOptions(mustObj(t, `{"contextTier":200000}`)); err != nil {
		t.Fatal(err)
	}
	if got := s.NomiContextWith("chat", &tr); got == nil || got.Get("window") != float64(200_000) {
		t.Fatalf("capped window = %v", got)
	}
}
