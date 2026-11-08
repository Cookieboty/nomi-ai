package tasks

import (
	"strings"
	"testing"
)

func TestReplyLanguage(t *testing.T) {
	cases := map[string]string{
		"Generate a series of 6 posters for the launch": "English",
		"给 README 补一节安装说明":                              "中文",
		"把 src/api/client.ts 里的 fetchUser 改成 async 的":   "中文",
		"新しいロゴを3案作って":                                   "日本語",
		"포스터 세 장 만들어 줘":                                 "한국어",
	}
	for in, want := range cases {
		if got := ReplyLanguage(in); got != want {
			t.Errorf("%q: got %s want %s", in, got, want)
		}
	}
	// 标题和目标一起看
	if got := ReplyLanguage("fix it", "修复登录页的报错"); got != "中文" {
		t.Errorf("title: %s", got)
	}
}

func TestBuildPromptUsesTaskLanguage(t *testing.T) {
	sp := func(s string) *string { return &s }
	msgs := BuildPrompt(AttemptContext{Task: Task{Title: "Posters", Goal: "Generate a series of 6 posters",
		Executor: ExecutorSpec{Kind: "nomi", Toolset: sp("conversation")}}, Attempt: Attempt{Cause: AttemptCause{Kind: "manual"}}}, "", 0, nil)
	if !strings.Contains(msgs[0].Content, "English") || strings.Contains(msgs[0].Content, "用中文") {
		t.Fatal(msgs[0].Content)
	}
}
