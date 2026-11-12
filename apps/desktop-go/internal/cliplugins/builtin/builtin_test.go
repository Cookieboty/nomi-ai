package builtin

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/catalog"
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

// 由插件能力推出来的名单（Gemini 没有官方账号：Google 不再让 Gemini CLI 用个人账号登录）
func TestDerivedLists(t *testing.T) {
	for name, c := range map[string]struct{ got, want []string }{
		"accounts": {Where(WithAccounts), []string{"claude", "codex", "grok", "kimi", "minimax"}},
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

// 清单 host.homeEnv 与插件账号能力的 HomeEnv 一致（沙箱按清单放行这个变量指向的目录）；每个内置 CLI 都要有
func TestHomeEnvMatchesPlugin(t *testing.T) {
	for _, id := range IDs {
		env := HomeEnv(id)
		if env == "" {
			t.Errorf("%s: manifest host.homeEnv missing", id)
		}
		if a := Impl(id).Accounts; a != nil && a.HomeEnv != env {
			t.Errorf("%s: plugin HomeEnv %q != manifest host.homeEnv %q", id, a.HomeEnv, env)
		}
		if len(catalog.HostList(id, "homeDirs")) == 0 {
			t.Errorf("%s: manifest host.homeDirs missing", id)
		}
	}
}
