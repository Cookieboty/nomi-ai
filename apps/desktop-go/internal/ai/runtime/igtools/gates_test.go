package igtools

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

// 工具分组的判定语料
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
		// 选了工作区：查看类总是提供，改动类要说到改动
		{"fs_read_text", "讲个笑话", true, "/Users/me/proj"},
		{"fs_write_text", "讲个笑话", false, "/Users/me/proj"},
		{"fs_write_text", "分析一下这个仓库的架构", false, "/Users/me/proj"},
		{"fs_edit", "把 README 里的错别字改一下", true, "/Users/me/proj"},
		{"fs_trash", "删掉 tmp 目录", true, "/Users/me/proj"},
		{"delegate_to_cli", "让 codex 修一下这个 bug", true, ""},
		{"delegate_to_cli", "晚饭吃什么", false, ""},
		{"delegate_to_cli", "分析当前在工作台直接调用各种cli都是什么方案，是acp吗？", false, "/Users/me/proj"},
		{"fs_write_text", "分析当前在工作台直接调用各种cli都是什么方案，是acp吗？", false, "/Users/me/proj"},
		// 派给后台的 Nomi：说到要做一阵子的事（文档 / 报告 / 一组图 / 后台做）时提供；问进度、要停下时提供查询 / 停止
		{"delegate_to_nomi", "晚饭吃什么", false, ""},
		{"delegate_to_nomi", "帮我写一份竞品调研报告", true, ""},
		{"delegate_to_nomi", "做一组小红书配图", true, ""},
		{"delegate_to_nomi", "后台慢慢做，做好叫我", true, ""},
		{"delegate_to_nomi", "帮我做个 PPT", true, ""},
		{"delegate_status", "海报做好了没", true, ""},
		{"delegate_stop", "那组图别做了", true, ""},
		{"delegate_status", "晚饭吃什么", false, ""},
		{"image_generate", "画一只猫", true, ""},
		{"image_generate", "晚饭吃什么", false, ""},
		{"set_user_preference", "以后叫我小王", true, ""},
		{"undo_last", "撤销刚才的操作", true, ""},
		{"time_now", "你好", true, ""},
		// 持续任务：以后 / 定期 / 某事发生时；闲聊不带（选了工作区也不带）
		{"task_propose", "每天 9 点看一下 CI，红了告诉我", true, ""},
		{"task_propose", "帮我盯着这个仓库，有新 issue 就说一声", true, ""},
		{"task_propose", "下周一帮我整理周报", true, ""},
		{"task_propose", "等编程助手跑完再帮我审一下", true, ""},
		{"task_propose", "把这件事做成一个任务", true, ""},
		{"task_propose", "check my inbox every morning", true, ""},
		{"task_propose", "介绍下你自己", false, "/Users/me/proj"},
		{"task_propose", "晚饭吃什么", false, ""},
		{"task_recall", "之前那个任务跑得怎么样", true, ""},
		{"task_recall", "海报做好了没", true, ""},
		{"task_recall", "讲个笑话", false, ""},
		// 兜底：用户的说法没命中、助手回复里提议了「持续任务」→ 下一轮带上（ConvoText 含助手的话）
		{"task_propose", "这个周报能不能帮我弄成固定的 这个可以设成持续任务，要我起草吗？", true, ""},
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

// 「做还是派出去」的规则跟派出去的工具同一个门槛
func TestDispatchRelevantFor(t *testing.T) {
	msgs := func(text string) any {
		return []any{map[string]any{"role": "system", "content": "调研报告"}, map[string]any{"role": "user", "content": text}}
	}
	if DispatchRelevantFor(msgs("晚饭吃什么")) {
		t.Error("闲聊不带（system 里的字不算）")
	}
	if !DispatchRelevantFor(msgs("帮我写一份调研报告")) {
		t.Error("要做一阵子的事要带")
	}
	if DispatchRelevantFor(nil) {
		t.Error("没有消息不带")
	}
}

// 上一轮的真实问题（选了工作区，只是问问题）：不带写文件、派出去的工具
func TestToolGatesReadOnlyQuestion(t *testing.T) {
	turn := tools.Turn{ConvoText: "分析当前在工作台直接调用各种cli都是什么方案，是acp吗？", Cwd: "/Users/me/proj"}
	for _, name := range []string{"fs_write_text", "fs_edit", "fs_trash", "delegate_to_cli", "delegate_to_nomi", "delegate_status"} {
		if tools.IsRelevant(WithGate(tools.Definition{Name: name}), turn) {
			t.Errorf("%s should not be offered", name)
		}
	}
	for _, name := range []string{"fs_read_text", "fs_search", "fs_list"} {
		if !tools.IsRelevant(WithGate(tools.Definition{Name: name}), turn) {
			t.Errorf("%s should be offered", name)
		}
	}
	if DispatchRelevant(turn) {
		t.Error("dispatch rules should not be added")
	}
}
