package gwstore

import (
	"path/filepath"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func newPriceAliasService(t *testing.T) *Service {
	t.Helper()
	ud := t.TempDir()
	s := NewService(filepath.Join(ud, "gateway"), fakeCipher{}, nil, nil)
	port := 0
	s.AttachRuntime(RuntimeDeps{Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{}})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	return s
}

func addProvider(t *testing.T, s *Service, name, url string, models []any, modelMap []any) string {
	t.Helper()
	in := u.NewObj("name", name, "urls", u.NewObj("chat", url), "newKeys", []any{u.NewObj("value", "sk-test-0000000000000000")},
		"models", models)
	if modelMap != nil {
		in.Set("modelMap", modelMap)
	}
	v, err := s.UpsertProvider(in)
	if err != nil {
		t.Fatal(err)
	}
	return v.Get("id").(string)
}

func mdl(id, like string) any {
	m := u.NewObj("id", id, "enabled", true)
	if like != "" {
		m.Set("like", like)
	}
	return m
}

func mapRow(from, to string) any { return u.NewObj("from", from, "to", to) }

// 账本记的是映射后的上游名：反查 modelMap 取公开名的 like（#256）
func TestPriceAliasFollowsModelMap(t *testing.T) {
	s := newPriceAliasService(t)
	relay := addProvider(t, s, "Relay", "https://relay.example.com/v1",
		[]any{mdl("custom-opus", "claude-opus-4-8"), mdl("plain", "")},
		[]any{mapRow("custom-opus", "vendor-model-123")})

	for _, c := range []struct{ model, provider, want string }{
		{"custom-opus", relay, "claude-opus-4-8"},      // 没映射时按公开名（原行为）
		{"vendor-model-123", relay, "claude-opus-4-8"}, // 映射后的上游名
		{"Vendor-Model-123", relay, "claude-opus-4-8"}, // 不分大小写
		{"vendor-model-123", "", "claude-opus-4-8"},    // 没给供应商：各家一致才用
		{"plain", relay, ""},                           // 没设 like：仍不计价别名
		{"unknown", relay, ""},
	} {
		if got := s.PriceAlias(c.model, c.provider); got != c.want {
			t.Errorf("PriceAlias(%q, %q) = %q, want %q", c.model, c.provider, got, c.want)
		}
	}
}

// 多个公开名映射到同一个上游名：like 一致才用，不一致或有的没设就不猜（#256）
func TestPriceAliasAmbiguousModelMap(t *testing.T) {
	s := newPriceAliasService(t)
	same := addProvider(t, s, "Same", "https://same.example.com/v1",
		[]any{mdl("a", "claude-opus-4-8"), mdl("b", "claude-opus-4-8")},
		[]any{mapRow("a", "up-1"), mapRow("b", "up-1")})
	diff := addProvider(t, s, "Diff", "https://diff.example.com/v1",
		[]any{mdl("a", "claude-opus-4-8"), mdl("b", "gpt-5")},
		[]any{mapRow("a", "up-2"), mapRow("b", "up-2")})
	partial := addProvider(t, s, "Partial", "https://partial.example.com/v1",
		[]any{mdl("a", "claude-opus-4-8"), mdl("b", "")},
		[]any{mapRow("a", "up-3"), mapRow("b", "up-3")})
	if got := s.PriceAlias("up-1", same); got != "claude-opus-4-8" {
		t.Errorf("consistent likes: %q", got)
	}
	if got := s.PriceAlias("up-2", diff); got != "" {
		t.Errorf("conflicting likes must not be guessed: %q", got)
	}
	if got := s.PriceAlias("up-3", partial); got != "" {
		t.Errorf("a mapped model without like must not be guessed: %q", got)
	}
}
