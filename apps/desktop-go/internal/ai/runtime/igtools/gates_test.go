package igtools

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

// 与 Node tests/unit/desktop/toolGates.test.ts 同一组语料
func TestToolGates(t *testing.T) {
	cases := []struct {
		name, text string
		want       bool
		cwd        string
	}{
		{"reminder_create", "明早八点提醒我开会", true, ""},
		{"reminder_create", "你好呀", false, ""},
		{"clipboard_read", "看看我剪贴板里是什么", true, ""},
		{"browser_open", "帮我打开 https://example.com", true, ""},
		{"browser_open", "今天心情不错", false, ""},
		{"code_run", "帮我算一下 17 的阶乘", true, ""},
		{"random", "掷个骰子", true, ""},
		{"echo", "随便说点什么", false, ""},
		{"fs_write_text", "把这段话保存到桌面", true, ""},
		{"fs_write_text", "讲个笑话", false, ""},
		{"fs_write_text", "讲个笑话", true, "/Users/me/proj"},
		{"delegate_to_cli", "让 codex 修一下这个 bug", true, ""},
		{"delegate_to_cli", "晚饭吃什么", false, ""},
		// 派给后台的 Nomi 总是提供（要靠它判断这件事要不要派出去）；问进度、要停下时提供查询 / 停止
		{"delegate_to_nomi", "晚饭吃什么", true, ""},
		{"delegate_status", "海报做好了没", true, ""},
		{"delegate_stop", "那组图别做了", true, ""},
		{"delegate_status", "晚饭吃什么", false, ""},
		{"image_generate", "画一只猫", true, ""},
		{"image_generate", "晚饭吃什么", false, ""},
		{"set_user_preference", "以后叫我小王", true, ""},
		{"undo_last", "撤销刚才的操作", true, ""},
		{"time_now", "你好", true, ""},
	}
	for _, c := range cases {
		d := WithGate(tools.Definition{Name: c.name})
		got := tools.IsRelevant(d, tools.Turn{UserText: c.text, ConvoText: strings.ToLower(c.text), Cwd: c.cwd})
		if got != c.want {
			t.Errorf("%s「%s」= %v, want %v", c.name, c.text, got, c.want)
		}
	}
	own := func(tools.Turn) bool { return true }
	if d := WithGate(tools.Definition{Name: "random", Relevant: own}); !d.Relevant(tools.Turn{}) {
		t.Error("WithGate 覆盖了工具自己的 Relevant")
	}
}
