package main

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
)

// 等你处理的条目属于哪个会话：编程助手的请求在它的标签，Nomi 的确认 / 提问在主对话，持续任务不属于会话
func TestIslandSessionOf(t *testing.T) {
	for id, want := range map[string]string{
		"perm\x1ftab_3\x1freq9":        "tab_3",
		"sbx\x1ftab_1\x1fs2":           "tab_1",
		"ask\x1ftab\x1ftab_2\x1fq1":    "tab_2",
		"ask\x1fnomi\x1fconv_1\x1fq1":  island.MainSession,
		"confirm\x1fc1":                island.MainSession,
		"task\x1ftk_7\x1f1\x1fapprove": "",
	} {
		if got := islandSessionOf(id); got != want {
			t.Errorf("%q → %q, want %q", id, got, want)
		}
	}
}
