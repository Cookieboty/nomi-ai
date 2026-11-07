package codinghandlers

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 视图建标签带来的内部字段（委派、沙箱预授权、账号、会话）一律丢掉，只留契约声明的
func TestViewTabOptionsDropsInternalFields(t *testing.T) {
	in := util.NewObj("backend", "claude", "cwd", "/p", "title", "x", "messages", []any{}, "permissionMode", "default",
		"pluginId", "ext",
		"delegation", util.NewObj("sandboxGrants", []any{"ssh", "cloud", "keys"}, "githubAccess", true),
		"source", "thirdParty", "accountId", "a1", "cliSessionId", "s1", "modelOverride", "m", "activate", false)
	out := viewTabOptions(in)
	if got := len(out.Keys()); got != len(viewTabFields) {
		t.Fatalf("kept %d fields: %v", got, out.Keys())
	}
	for _, k := range []string{"delegation", "source", "accountId", "cliSessionId", "modelOverride", "activate"} {
		if _, ok := out.Lookup(k); ok {
			t.Errorf("%s must be dropped", k)
		}
	}
	if out.Get("backend") != "claude" || out.Get("cwd") != "/p" {
		t.Fatal("declared fields kept")
	}
}
