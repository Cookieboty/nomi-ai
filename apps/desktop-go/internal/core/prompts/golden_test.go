package prompts_test

// 提示词快照：各处拼出来的提示词逐字对照 testdata/*.golden。改了提示词跑
// `go test ./internal/core/prompts -update` 重新生成，在 diff 里核对改动。

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codingcli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/persona"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/repotest"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden")

func TestMain(m *testing.M) {
	time.Local = time.UTC // 提示词里的时间按本地时区格式化：快照固定时区
	os.Exit(m.Run())
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.WriteFile(p, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("%s: %v (run with -update)", name, err)
	}
	if string(want) != got {
		t.Errorf("%s differs from %s:\n--- got ---\n%s\n--- want ---\n%s", name, p, got, want)
	}
}

func msgs[M any](xs []M, role func(M) string, content func(M) string) string {
	var b strings.Builder
	for _, m := range xs {
		b.WriteString("### " + role(m) + "\n" + content(m) + "\n")
	}
	return b.String()
}

func depsMsgs(xs []deps.Msg) string {
	return msgs(xs, func(m deps.Msg) string { return m.Role }, func(m deps.Msg) string { return m.Content })
}

func sp(s string) *string { return &s }

func withLocale(t *testing.T, l string) {
	t.Helper()
	i18n.SetLocale(func() string { return l })
	t.Cleanup(func() { i18n.SetLocale(nil) })
}

func TestMemorySummary(t *testing.T) {
	golden(t, "memory-summary", depsMsgs(memory.SummaryPrompt([]memory.TurnMsg{
		{Role: "user", Content: "我叫小王，  喜欢喝咖啡"}, {Role: "assistant", Content: "记住了"},
	})))
}

func TestTaskRun(t *testing.T) {
	now := int64(1_762_300_000_000)
	run := func(ex tasks.ExecutorSpec, cause tasks.AttemptCause, progress string, ev []tasks.SourceEvent) string {
		ctx := tasks.AttemptContext{
			Task:    tasks.Task{Title: "整理周报", Goal: "把本周的提交整理成周报", Executor: ex},
			Attempt: tasks.Attempt{Cause: cause},
		}
		var b strings.Builder
		for _, m := range tasks.BuildPrompt(ctx, progress, now, ev) {
			b.WriteString("### " + m.Role + "\n" + m.Content + "\n")
		}
		return b.String()
	}
	golden(t, "task-run-plain", run(tasks.ExecutorSpec{Kind: "nomi"}, tasks.AttemptCause{Kind: "schedule"}, "", nil))
	golden(t, "task-run-conversation", run(tasks.ExecutorSpec{Kind: "nomi", Toolset: sp("conversation"), Cwd: sp("/work"),
		Brief: &tasks.Brief{DoneWhen: "周报写进 weekly.md", Context: sp("上周的周报在 last.md")}},
		tasks.AttemptCause{Kind: "rework", Note: sp("太长了"), Answer: &tasks.Answer{Approve: true, Input: sp("可以发")}},
		"已经读完提交记录", []tasks.SourceEvent{{Summary: "新的 PR", Payload: map[string]any{"n": 1}}}))
	golden(t, "task-run-resume", run(tasks.ExecutorSpec{Kind: "nomi", Toolset: sp("conversation")},
		tasks.AttemptCause{Kind: "resume", Answer: &tasks.Answer{Approve: false}}, "", nil))
	// 本机没有可委派的编程助手：代码由后台的 Nomi 自己写
	codingcli.Set(func() bool { return false })
	defer codingcli.Set(nil)
	golden(t, "task-run-conversation-nocli", run(tasks.ExecutorSpec{Kind: "nomi", Toolset: sp("conversation"), Cwd: sp("/work")},
		tasks.AttemptCause{Kind: "manual"}, "", nil))
}

func TestDelegateBrief(t *testing.T) {
	golden(t, "delegate-brief-full", delegate.BuildDelegatePrompt(delegate.DelegateBrief{
		Goal: " 修好登录 ", Context: "报错在 auth.go", DoneWhen: "测试通过", OutOfScope: "不要改数据库"}))
	golden(t, "delegate-brief-min", delegate.BuildDelegatePrompt(delegate.DelegateBrief{Goal: "修好登录", DoneWhen: "测试通过"}))
	golden(t, "dispatch-hint", delegate.DispatchHint)
	golden(t, "dispatch-hint-nocli", delegate.DispatchHintFor(false))
}

func TestDesktop(t *testing.T) {
	one := desktop.Workspace{Primary: "/work"}
	multi := desktop.Workspace{Primary: "/work/app", Extra: []string{"/work/server", "/work/docs"}}
	golden(t, "workspace", desktop.WorkspaceSystemHint("", one, false)+"\n---\n"+desktop.WorkspaceSystemHint("", one, true))
	golden(t, "workspace-multi", desktop.WorkspaceSystemHint("跨端", multi, false))
	codingcli.Set(func() bool { return false })
	golden(t, "workspace-nocli", desktop.WorkspaceSystemHint("", one, false))
	codingcli.Set(nil)
	var got []string
	sum := func(text, instr string) (string, error) { got = append(got, instr); return "ok", nil }
	if _, err := desktop.SummarizeText(sum, "短文本", "tldr", "auto", 200, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.SummarizeText(sum, "短文本", "nope", "English", 100, "b.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.SummarizeText(sum, strings.Repeat("长文本。", 20000), "action-items", "中文", 300, "c.txt"); err != nil {
		t.Fatal(err)
	}
	golden(t, "file-summary", strings.Join(got, "\n"))
	golden(t, "command-review", msgs(desktop.ReviewMessages(desktop.CommandReviewInput{
		Tool: "workspace_run", Command: "rm -rf build", Cwd: "/work", UserText: "清理构建产物", Tainted: true}),
		func(m map[string]string) string { return m["role"] }, func(m map[string]string) string { return m["content"] }))
}

func TestKnowledgeAsk(t *testing.T) {
	golden(t, "knowledge-ask", depsMsgs(knowledge.BuildAskMessages("年假几天？",
		[]knowledge.Hit{{Title: "员工手册", Page: 3, Text: "年假 10 天"}, {Title: "FAQ", Text: "见手册"}},
		[]deps.Msg{{Role: "user", Content: "你好"}, {Role: "assistant", Content: "你好"}})))
}

func TestCommitMessage(t *testing.T) {
	ms := cli.CommitMessagePrompt(cli.GitCommitContext{Subjects: []string{"fix: a", "feat: b"}, Stat: "a.go | 2 +-", Diff: "@@ diff", Truncated: true})
	golden(t, "commit-message", msgs(ms, func(m cli.CommitMessageMsg) string { return m.Role }, func(m cli.CommitMessageMsg) string { return m.Content }))
	golden(t, "plan-mode", shared.PlanPromptPrefix)
}

func TestChatGuidance(t *testing.T) {
	for _, l := range []string{"zh-CN", "en"} {
		withLocale(t, l)
		p := &persona.Persona{SystemPromptIdentity: "  你是测试角色。 "}
		golden(t, "chat-guidance-"+l, persona.DefaultSystemPrompt(p))
	}
}

func TestSchedule(t *testing.T) {
	for _, l := range []string{"zh-CN", "en"} {
		withLocale(t, l)
		full := prompts.Local("schedule-context", map[string]any{"Date": "2026/11/5", "WeekZh": "四", "Weekday": "Thursday",
			"Time": "09:30", "Reminders": []string{"- 10:00 开会", "- 15:00 取快递"}, "Upcoming": []string{"18:00 日报", "21:00 复盘"},
			"Memory": "用户喜欢喝咖啡"})
		empty := prompts.Local("schedule-context", map[string]any{"Date": "2026/11/5", "WeekZh": "四", "Weekday": "Thursday",
			"Time": "09:30", "Reminders": []string{}, "Upcoming": []string(nil), "Memory": ""})
		golden(t, "schedule-"+l, strings.Join([]string{
			prompts.Local("schedule-task", map[string]any{"Name": "早报", "Context": full}),
			prompts.Local("schedule-proactive", map[string]any{"Context": empty}),
			prompts.Local("schedule-proactive-user", nil),
			prompts.Local("schedule-memory-query", nil),
		}, "\n---\n"))
	}
}

// 每个提示词文件都有代码在用；跟着语言走的中英文成对
func TestPromptFilesUsed(t *testing.T) {
	var src strings.Builder
	root := repotest.RepoPath("apps", "desktop-go", "internal")
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".go") && !strings.HasSuffix(p, "_test.go") {
			b, _ := os.ReadFile(p)
			src.Write(b)
		}
		return nil
	})
	names := map[string]bool{}
	for _, n := range prompts.Names() {
		names[n] = true
	}
	for n := range names {
		base := n
		if lang, rest, ok := strings.Cut(n, "/"); ok {
			base = rest
			other := map[string]string{"zh": "en", "en": "zh"}[lang]
			if !names[other+"/"+rest] {
				t.Errorf("%s has no %s counterpart", n, other)
			}
		}
		if !strings.Contains(src.String(), `"`+base+`"`) {
			t.Errorf("prompt %s is not used by any Go code", n)
		}
	}
}
