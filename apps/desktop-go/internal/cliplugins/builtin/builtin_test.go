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
		"history":  {Where(WithHistory), []string{"claude", "codex", "dsh", "grok", "gemini"}},
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

// 代码条目与清单（catalog）一一对应；清单说能读历史的，插件确实有 History 与会话记录解析
func TestEntriesMatchCatalog(t *testing.T) {
	if len(entries) != len(IDs) {
		t.Fatalf("entries %d vs catalog %d", len(entries), len(IDs))
	}
	for _, id := range IDs {
		e, ok := entries[id]
		if !ok || e.CreateMain == nil {
			t.Fatalf("%s is in the catalog but has no CreateMain in builtin.entries", id)
		}
		has := e.Transcript != nil && Impl(id).History != nil
		if has != WithHistory(id) {
			t.Errorf("%s: manifest history=%v but implementation=%v", id, WithHistory(id), has)
		}
	}
}

// Kimi / MiniMax 的档位映射来自清单
func TestAcpPermissionsFromManifest(t *testing.T) {
	k := Impl("kimi").Permissions
	for mode, id := range map[string]string{"plan": "plan", "manual": "default", "auto": "yolo", "bypass": "auto", "acceptEdits": "default"} {
		if got := k.ModeID(mode); got != id {
			t.Errorf("kimi %s → %s, want %s", mode, got, id)
		}
	}
	if k.FromModeID("auto") != "bypass" || k.FromModeID("yolo") != "auto" || k.FromModeID("x") != "" {
		t.Error("kimi FromModeID")
	}
	m := Impl("minimax").Permissions
	if !slices.Equal(m.Supported, []string{"plan", "manual"}) || m.ModeID("bypass") != "default" {
		t.Errorf("minimax %v %s", m.Supported, m.ModeID("bypass"))
	}
}
