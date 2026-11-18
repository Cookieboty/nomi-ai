package main

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

func spReuseKey(s string) *string { return &s }

// 给了完整 spec 时直接用，不再去解析档位（档位被改 / 删掉也不影响这次标识）
func TestTaskReuseKeyUsesSuppliedSpec(t *testing.T) {
	task := tasks.Task{Category: spReuseKey("coding"), Executor: tasks.ExecutorSpec{Kind: "cli", Cli: spReuseKey("claude"), PresetID: spReuseKey("deleted")}}
	task.Origin.ConversationID = spReuseKey("conv1")
	spec := &tasks.TaskRunSpec{Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol", ReasoningEffort: "high"}
	want := delegate.ReuseKeyWithSource("conv1", "codex", "official", "acct-codex", "/repo", "coding", "gpt-6.1-sol", "high")
	if got := taskReuseKey(task, "/repo", spec); got != want || got == "" {
		t.Fatalf("taskReuseKey(spec)=%q want %q", got, want)
	}
}

// 没给 spec 且档位已删除：返回空，不复用旧标签，也不退回保存时的旧 cli
func TestTaskReuseKeyMissingPresetEmpty(t *testing.T) {
	task := tasks.Task{Executor: tasks.ExecutorSpec{Kind: "cli", Cli: spReuseKey("claude"), PresetID: spReuseKey("deleted")}}
	task.Origin.ConversationID = spReuseKey("conv1")
	if got := taskReuseKey(task, "/repo", nil); got != "" {
		t.Fatalf("missing preset must not produce a reuse key, got %q", got)
	}
}

// 显式（非档位）任务：没有 spec 时沿用保存的 cli / 来源 / 账号原样拼标识
func TestTaskReuseKeyExplicitTask(t *testing.T) {
	task := tasks.Task{Executor: tasks.ExecutorSpec{Kind: "cli", Cli: spReuseKey("claude"), Source: spReuseKey("local")}}
	task.Origin.ConversationID = spReuseKey("conv1")
	want := delegate.ReuseKeyWithSource("conv1", "claude", "local", "", "/repo", "", "", "")
	if got := taskReuseKey(task, "/repo", nil); got != want {
		t.Fatalf("taskReuseKey(explicit)=%q want %q", got, want)
	}
}
