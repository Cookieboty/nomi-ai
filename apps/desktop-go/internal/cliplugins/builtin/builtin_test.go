package builtin

import (
	"slices"
	"testing"
)

// 每个内置 CLI 都在 Ordered 里排了位置，且只出现一次
func TestOrderedCoversAll(t *testing.T) {
	o := slices.Clone(Ordered)
	slices.Sort(o)
	if !slices.Equal(o, IDs) {
		t.Fatalf("Ordered %v must list every builtin id %v exactly once", Ordered, IDs)
	}
}

// 由插件能力推出来的名单（前五个与原来写死的一致；Kimi / MiniMax 只有官方账号）
func TestDerivedLists(t *testing.T) {
	for name, c := range map[string]struct{ got, want []string }{
		"accounts": {Where(WithAccounts), []string{"claude", "codex", "grok", "gemini", "kimi", "minimax"}},
		"history":  {Where(WithHistory), []string{"claude", "codex", "grok", "gemini", "dsh"}},
		"quota":    {Where(WithQuota), []string{"claude", "codex", "grok"}},
	} {
		if !slices.Equal(c.got, c.want) {
			t.Errorf("%s = %v, want %v", name, c.got, c.want)
		}
	}
	for id, want := range map[string][2]string{
		"claude": {"Claude Code", "Claude Code"}, "codex": {"Codex", "Codex"}, "grok": {"Grok", "Grok"},
		"gemini": {"Gemini", "Gemini CLI"}, "dsh": {"dsh", "dsh"}, "kimi": {"Kimi Code", "Kimi Code"},
		"minimax": {"MiniMax Code", "MiniMax Code"},
	} {
		if DisplayName(id) != want[0] || FullName(id) != want[1] {
			t.Errorf("%s names = %q / %q", id, DisplayName(id), FullName(id))
		}
	}
}
