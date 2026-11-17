package accounts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// seedClaudeUser 造一个用户侧 claude 配置目录（settings.json + .claude.json）。
func seedClaudeUser(t *testing.T, root, settings string, claudeJSON map[string]any) (user, acct string) {
	t.Helper()
	user = filepath.Join(root, "user")
	acct = filepath.Join(root, "acct")
	if err := os.MkdirAll(user, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(user, "settings.json"), []byte(settings), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(claudeJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(user, ".claude.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	return user, acct
}

// 「自动」档的前置状态要跟着用户走：Nomi 的标签是 -p 非交互进程，CLI 缺了这些状态就判定
// 「本 session 跑不了安全检查」（auto_mode_no_check_in_session），没有第四个人可以问，
// 于是每个需要检查的动作都被硬拒。
func TestEnsureAccountHomeInheritsAutoModeState(t *testing.T) {
	old := time.Now().Add(-48 * time.Hour).UnixMilli()
	user, acct := seedClaudeUser(t, t.TempDir(),
		`{"autoMode":{"environment":["工作目录是 /tmp"],"soft_deny":["$defaults"]}}`,
		map[string]any{
			"hasSeenAutoModeEntryWarning":      true,
			"hasSeenAutoDefaultNotice":         true,
			"hasSeenAutoModeOutsideReadPrompt": true,
			"autoModeEnvSetup":                 map[string]any{"denials": float64(5)},
			autoClassifierConsentKey:           float64(old),
			"theme":                            "dark",
		})

	if _, err := EnsureAccountHome("claude", acct, user, "darwin"); err != nil {
		t.Fatal(err)
	}
	got := readJSONObj(filepath.Join(acct, ".claude.json"))
	if got == nil {
		t.Fatal("agent 的 .claude.json 没写出来")
	}

	for _, k := range []string{
		"hasSeenAutoModeEntryWarning", "hasSeenAutoDefaultNotice",
		"hasSeenAutoModeOutsideReadPrompt", "autoModeEnvSetup",
	} {
		if v, ok := got.Lookup(k); !ok || isUndef(v) {
			t.Errorf("%s 应该从用户配置继承", k)
		}
	}
	if v, ok := got.Lookup("theme"); !ok || v != "dark" {
		t.Errorf("原有白名单（theme）不该被弄丢")
	}

	// 24 小时时效：过了期的确认必须续成当前时间，否则 CLI 悄悄停摆
	v, ok := got.Lookup(autoClassifierConsentKey)
	if !ok {
		t.Fatal("计费确认应该被续期")
	}
	ms, _ := v.(float64)
	if age := time.Since(time.UnixMilli(int64(ms))); age > time.Minute {
		t.Fatalf("计费确认没续期，还是 %v 前", age)
	}
}

// 用户从没配过 autoMode 时不写这份同意，不替没开自动档的人造一个。
func TestEnsureAccountHomeLeavesAutoConsentAloneWithoutAutoMode(t *testing.T) {
	user, acct := seedClaudeUser(t, t.TempDir(), `{"env":{}}`, map[string]any{"theme": "light"})

	if _, err := EnsureAccountHome("claude", acct, user, "darwin"); err != nil {
		t.Fatal(err)
	}
	got := readJSONObj(filepath.Join(acct, ".claude.json"))
	if got == nil {
		t.Fatal("agent 的 .claude.json 没写出来")
	}
	if _, ok := got.Lookup(autoClassifierConsentKey); ok {
		t.Fatal("没配 autoMode 时不该写计费确认")
	}
}
