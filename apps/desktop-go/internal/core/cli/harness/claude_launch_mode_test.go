package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func ptr(s string) *string { return &s }

// 「自动」默认原样下发：用户选了什么模型、换了哪个供应商，都不该被我们按名字猜着改档。
// 能不能跑是端点能力问题（分类器附带请求有没有透传），不是模型名问题。
func TestClaudeAutoSentAsIsForAnyModel(t *testing.T) {
	o := &Orchestrator{autoMode: cli.NewAutoModeTable(t.TempDir(), nil)}
	for _, model := range []string{
		"", "claude-fable-5", "amux/claude-fable-5", "amux/deepseek-v4.1-flash", "amux/gpt-6.1-terra",
		"my-relay/some-alias-that-is-claude", "claude-but-not-really",
	} {
		key := cli.AutoModeKey("https://relay.example/v1", model)
		tab := util.NewObj("backend", "claude", "permissionMode", "auto")
		if got := o.claudeLaunchMode(tab, key); got != "auto" {
			t.Errorf("模型 %q：学到跑不通之前必须原样下发 auto，实际 %q", model, got)
		}
		if tab.Get("permissionModeCli") != nil {
			t.Errorf("模型 %q 不该记 permissionModeCli", model)
		}
	}
}

// 学到这个「端点 + 模型」上 auto 跑不通之后，才降 acceptEdits（不是 bypass），并留痕。
func TestClaudeAutoFallsBackAfterLearned(t *testing.T) {
	root := t.TempDir()
	o := &Orchestrator{autoMode: cli.NewAutoModeTable(root, nil)}
	key := cli.AutoModeKey("https://relay.example/v1", "amux/deepseek-v4.1-flash")
	o.autoMode.NoteUnsupported(key, "auto_mode_no_check_in_session")

	tab := util.NewObj("backend", "claude", "permissionMode", "auto")
	if got := o.claudeLaunchMode(tab, key); got != "acceptEdits" {
		t.Fatalf("学到之后应降 acceptEdits，实际 %q", got)
	}
	if got := util.Str(tab.Get("permissionModeCli")); got != "acceptEdits" {
		t.Fatalf("应记 permissionModeCli=acceptEdits，实际 %q", got)
	}
	// 换个端点或换个模型 → 重新按 auto 试，不因为别处失败就牵连
	for _, k := range []string{
		cli.AutoModeKey("https://other.example/v1", "amux/deepseek-v4.1-flash"),
		cli.AutoModeKey("https://relay.example/v1", "amux/gpt-6.1-terra"),
		cli.AutoModeKey("", "amux/deepseek-v4.1-flash"),
	} {
		tab := util.NewObj("backend", "claude", "permissionMode", "auto")
		if got := o.claudeLaunchMode(tab, k); got != "auto" {
			t.Errorf("%s 应重新按 auto 下发，实际 %q", k, got)
		}
	}
	// 只有 auto 受影响
	for _, mode := range []string{"plan", "manual", "acceptEdits", "bypass"} {
		tab := util.NewObj("backend", "claude", "permissionMode", mode)
		if got := o.claudeLaunchMode(tab, key); got != mode {
			t.Errorf("%s 不该被改，实际 %q", mode, got)
		}
	}
}

// 学到的结果要落盘：重启后不该再白耗一轮。
func TestAutoModeTablePersists(t *testing.T) {
	root := t.TempDir()
	key := cli.AutoModeKey("https://relay.example/v1", "amux/deepseek-v4.1-flash")
	cli.NewAutoModeTable(root, nil).NoteUnsupported(key, "auto_mode_no_check_in_session")
	again := cli.NewAutoModeTable(root, nil)
	if got := again.Unsupported(key); got != "auto_mode_no_check_in_session" {
		t.Fatalf("重启后应还记得，实际 %q", got)
	}
	if got := again.Unsupported(cli.AutoModeKey("https://relay.example/v1", "other")); got != "" {
		t.Fatalf("不该串到别的模型，实际 %q", got)
	}
}

func TestAutoModeKey(t *testing.T) {
	if got := cli.AutoModeKey("", ""); got != "official|default" {
		t.Errorf("key = %q", got)
	}
	if got := cli.AutoModeKey("https://relay.example/v1", "amux/m"); got != "https://relay.example/v1|amux/m" {
		t.Errorf("key = %q", got)
	}
}
