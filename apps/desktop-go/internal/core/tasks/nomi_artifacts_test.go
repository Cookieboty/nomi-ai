package tasks

import (
	"context"
	"reflect"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
)

func TestNomiArtifacts(t *testing.T) {
	cases := []struct {
		tool, out string
		want      []Artifact
	}{
		{"image_generate", `{"ok":true,"data":{"images":[{"url":"chat-asset://images/gen-1.png"},{"url":"chat-asset://images/gen-2.png"}]}}`,
			[]Artifact{{ArtifactImage, "chat-asset://images/gen-1.png"}, {ArtifactImage, "chat-asset://images/gen-2.png"}}},
		{"fs_write_text", `{"ok":true,"data":{"path":"/w/a.md","mode":"create","undoId":"u1"}}`, []Artifact{{ArtifactFile, "/w/a.md"}}},
		{"fs_edit", `{"ok":true,"data":{"path":"/w/b.md","replacements":1,"undoId":"u2"}}`, []Artifact{{ArtifactFile, "/w/b.md"}}},
		{"fs_move", `{"ok":true,"data":{"from":"/w/x","to":"/w/y","undoId":"u3"}}`, []Artifact{{ArtifactFile, "/w/y"}}},
		// dryRun 预览（没有 undoId）、失败、只读工具里出现的图片地址都不算
		{"fs_write_text", `{"ok":true,"data":{"path":"/w/a.md","mode":"create","dryRun":true}}`, nil},
		{"fs_write_text", `{"ok":false,"error":{"code":"denied"}}`, nil},
		{"fs_read_text", `chat-asset://images/old.png`, nil},
	}
	for _, c := range cases {
		got := nomiArtifacts(c.tool, c.out)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%s %s: got %v want %v", c.tool, c.out, got, c.want)
		}
	}
}

// 生图任务：生成的图片记进结果；只出了图、最后没说话的也算做完（不再判 empty_result）
func TestNomiExecutorRecordsGeneratedImages(t *testing.T) {
	for _, reply := range []string{"两张图做好了", ""} {
		exec := NewNomiExecutor(NomiDeps{
			AgentStream: func(_ context.Context, _ []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
				emit(blm.ChatChunk{Type: "tool_call.result", ID: sp("t1"), Name: sp("image_generate"),
					Output: sp(`{"ok":true,"data":{"url":"chat-asset://images/gen-1.png"}}`)})
				emit(blm.ChatChunk{Type: "tool_call.result", ID: sp("t2"), Name: sp("image_generate"),
					Output: sp(`{"ok":true,"data":{"url":"chat-asset://images/gen-2.png"}}`)})
				// 同一张图再出现一次：去重
				emit(blm.ChatChunk{Type: "tool_call.result", ID: sp("t3"), Name: sp("image_generate"),
					Output: sp(`{"ok":true,"data":{"url":"chat-asset://images/gen-2.png"}}`)})
				// 失败的调用不算
				emit(blm.ChatChunk{Type: "tool_call.result", ID: sp("t4"), Name: sp("image_generate"),
					Output: sp(`chat-asset://images/bad.png`), Error: sp("boom")})
				if reply != "" {
					emit(blm.ChatChunk{Type: "delta", Content: reply})
				}
				return nil
			},
			Ready:     func() bool { return true },
			ToolNames: func() []string { return []string{"image_generate"} },
			Every:     func(int64, func()) func() { return func() {} },
		})
		rep := &beatReporter{completed: make(chan AttemptResult, 1)}
		task := Task{ID: "task_1", Title: "生图", Goal: "g", Executor: conversationExecutor(), Grant: Grant{Level: 3}}
		exec.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att_1", TaskID: "task_1", Gen: 1,
			Cause: AttemptCause{Kind: "manual"}}, Report: rep})
		r := <-rep.completed
		want := []Artifact{{ArtifactImage, "chat-asset://images/gen-1.png"}, {ArtifactImage, "chat-asset://images/gen-2.png"}}
		if r.Summary != reply || !reflect.DeepEqual(r.Artifacts, want) {
			t.Fatalf("reply %q: got %q %v", reply, r.Summary, r.Artifacts)
		}
	}
}
