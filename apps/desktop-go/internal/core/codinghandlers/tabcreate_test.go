package codinghandlers

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 视图建标签带来的内部字段（委派、沙箱预授权、账号、会话）一律丢掉，只留契约声明的
func TestViewTabOptionsDropsInternalFields(t *testing.T) {
	in := util.NewObj("backend", "claude", "cwd", "/p", "projectId", "p1", "title", "x", "messages", []any{}, "permissionMode", "default",
		"pluginId", "ext",
		"delegation", util.NewObj("sandboxGrants", []any{"ssh", "cloud", "keys"}, "githubAccess", true),
		"source", "thirdParty", "accountId", "a1", "cliSessionId", "s1", "modelOverride", "m", "activate", false)
	out := viewTabOptions(in)
	if got := len(out.Keys()); got != len(viewTabFields) {
		t.Fatalf("kept %d fields: %v", got, out.Keys())
	}
	// cwd：视图只能给项目，工作目录由内核按项目的主文件夹定
	for _, k := range []string{"cwd", "delegation", "source", "accountId", "cliSessionId", "modelOverride", "activate"} {
		if _, ok := out.Lookup(k); ok {
			t.Errorf("%s must be dropped", k)
		}
	}
	if out.Get("backend") != "claude" || out.Get("projectId") != "p1" {
		t.Fatal("declared fields kept")
	}
}
