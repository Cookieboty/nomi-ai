package tasks

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingCli struct {
	*fakeCli
	mu       sync.Mutex
	created  []CliCreateTab
	reuseCli []string
}

func newRecordingCli(bins map[string]bool) *recordingCli {
	return &recordingCli{fakeCli: newFakeCli(bins)}
}

func (r *recordingCli) CreateTab(o CliCreateTab) (string, error) {
	r.mu.Lock()
	r.created = append(r.created, o)
	r.mu.Unlock()
	return r.fakeCli.CreateTab(o)
}

func (r *recordingCli) createdTabs() []CliCreateTab {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]CliCreateTab(nil), r.created...)
}

type failReporter struct {
	beatReporter
	mu      sync.Mutex
	failed  []TaskError
	carrier []Carrier
}

func (r *failReporter) Failed(e TaskError) {
	r.mu.Lock()
	r.failed = append(r.failed, e)
	r.mu.Unlock()
}
func (r *failReporter) Carrier(c Carrier) {
	r.mu.Lock()
	r.carrier = append(r.carrier, c)
	r.mu.Unlock()
}

func (r *failReporter) failedCode() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.failed) == 0 {
		return ""
	}
	return r.failed[0].Code
}

func presetExecutor(t *testing.T, bins map[string]bool, presets map[string]*CliPresetSpec, reuseKey func(Task, string, *TaskRunSpec) string) (*cliExecutor, *recordingCli) {
	t.Helper()
	f := newRecordingCli(bins)
	deps := CliDeps{
		Harness: f,
		ResolvePreset: func(id string) *CliPresetSpec {
			return presets[id]
		},
		PrepareIsolation: func(cwd, key, _ string) (CliIsolation, error) {
			return CliIsolation{Kind: "in-place", Cwd: cwd, SourceCwd: cwd, GitRoot: cwd}, nil
		},
		GitChanged:  func(string) []string { return nil },
		BuildPrompt: func(goal, _, _, _ string) string { return goal },
		ParseReport: func(string) *CliReport { return nil },
		DirOk:       func(d string) bool { return d == "/repo" },
		ReuseKey:    reuseKey,
	}
	return NewCliExecutor(deps).(*cliExecutor), f
}

func waitFailed(t *testing.T, rep *failReporter) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rep.failedCode() != "" {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("executor did not fail in time")
}

// 档位模式只存 presetId：Prepare 不能因为 cli 为空判成 not a cli task，快照用当前档位的 cli / 模型
func TestCliPrepareResolvesCurrentPreset(t *testing.T) {
	e, _ := presetExecutor(t, map[string]bool{"claude": true, "codex": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol", ReasoningEffort: "high"},
	}, nil)
	// 存的是切档前的 claude 快照
	snap, err := e.Prepare(Task{Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), PresetID: sp("balanced"), Cwd: sp("/repo")}})
	if err != nil {
		t.Fatalf("Prepare preset task: %v", err)
	}
	if snap.Cli == nil || *snap.Cli != "codex" || snap.Model == nil || *snap.Model != "gpt-6.1-sol" {
		t.Fatalf("snapshot did not follow current preset: cli=%v model=%v", snap.Cli, snap.Model)
	}
}

// 档位已删除：Prepare / Start 都失败，绝不退回保存时的旧 cli
func TestCliPresetMissingFailsSafely(t *testing.T) {
	e, f := presetExecutor(t, map[string]bool{"claude": true}, map[string]*CliPresetSpec{}, nil)
	task := Task{ID: "t1", Goal: "g", Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), PresetID: sp("gone"), Cwd: sp("/repo")}}
	if _, err := e.Prepare(task); err == nil || err.Code != "config_changed" {
		t.Fatalf("Prepare should fail for missing preset, got %+v", err)
	}
	rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
	e.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att1", TaskID: "t1", Gen: 1}, Report: rep})
	waitFailed(t, rep)
	if got := len(f.createdTabs()); got != 0 {
		t.Fatalf("missing preset must not create a tab, got %d", got)
	}
	if got := f.sendCount(); got != 0 {
		t.Fatalf("missing preset must not send, got %d", got)
	}
}

// 显式（非档位）任务行为不变：保存的 cli / 来源 / 账号原样使用
func TestCliExplicitTaskKeepsSavedSpec(t *testing.T) {
	e, _ := presetExecutor(t, map[string]bool{"claude": true, "codex": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "codex"},
	}, nil)
	snap, err := e.Prepare(Task{Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), Source: sp("local"), Cwd: sp("/repo")}})
	if err != nil || snap.Cli == nil || *snap.Cli != "claude" {
		t.Fatalf("explicit task should keep claude, err=%v snap=%v", err, snap.Cli)
	}
}

// 档位 Claude -> Codex：Start 新建标签用当前档位的 codex，复用标识拿到的是同一份完整参数（来源 / 账号 / 模型 / 思考深度）
func TestCliStartUsesCurrentPresetAfterEdit(t *testing.T) {
	var specs []TaskRunSpec
	e, f := presetExecutor(t, map[string]bool{"claude": true, "codex": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol", ReasoningEffort: "high"},
	}, func(t Task, cwd string, spec *TaskRunSpec) string {
		specs = append(specs, *spec)
		return "k:" + spec.Cli
	})
	task := presetOnlyTask()

	rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
	e.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att1", TaskID: "t1", Gen: 1}, Report: rep})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && f.sendCount() == 0 {
		time.Sleep(2 * time.Millisecond)
	}
	tabs := f.createdTabs()
	if len(tabs) != 1 {
		t.Fatalf("expected one created tab, got %d (failed=%v)", len(tabs), rep.failed)
	}
	got := tabs[0]
	if got.Backend != "codex" || got.Source != "official" || got.AccountID != "acct-codex" || got.ModelOverride != "gpt-6.1-sol" || got.ReasoningEffort != "high" {
		t.Fatalf("tab did not follow current preset: %+v", got)
	}
	want := TaskRunSpec{Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol", ReasoningEffort: "high"}
	if len(specs) != 1 || specs[0] != want {
		t.Fatalf("reuse key must receive the resolved full spec, got %+v", specs)
	}
	if got.ReuseKey != "k:codex" {
		t.Fatalf("reuse key %q", got.ReuseKey)
	}
	f.finish("done")
}

// 档位任务不存 cli（只存 presetId）：Prepare / Start 都必须按档位跑，不能判成「not a cli task」
func TestCliPresetOnlyTaskWithoutCli(t *testing.T) {
	e, f := presetExecutor(t, map[string]bool{"codex": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol"},
	}, nil)
	task := presetOnlyTask()
	snap, err := e.Prepare(task)
	if err != nil || snap.Cli == nil || *snap.Cli != "codex" {
		t.Fatalf("Prepare preset-only task: err=%v snap=%v", err, snap.Cli)
	}
	rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
	e.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att1", TaskID: "t1", Gen: 1}, Report: rep})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && f.sendCount() == 0 {
		time.Sleep(2 * time.Millisecond)
	}
	if len(rep.failed) != 0 || f.sendCount() != 1 {
		t.Fatalf("preset-only task did not run: failed=%v sends=%d", rep.failed, f.sendCount())
	}
	if tabs := f.createdTabs(); len(tabs) != 1 || tabs[0].Backend != "codex" || tabs[0].AccountID != "acct-codex" {
		t.Fatalf("preset-only tabs: %+v", tabs)
	}
	f.finish("done")
}

// 续跑（Previous 载体）时档位已换成另一个 agent：停在 config_changed，绝不把新配置发到旧标签
func TestCliPresetCarrierAgentChangedFailsSafely(t *testing.T) {
	e, f := presetExecutor(t, map[string]bool{"claude": true, "codex": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol"},
	}, nil)
	f.tabs["tab_old"] = &fakeCliTab{cwd: "/repo"}
	task := presetOnlyTask()
	prev := &Attempt{ID: "att0", TaskID: "t1", Gen: 1, Snapshot: ExecutionSnapshot{Cli: sp("claude")},
		Carrier: &Carrier{TabID: sp("tab_old"), Cwd: sp("/repo"), SourceCwd: sp("/repo")}}
	rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
	e.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att2", TaskID: "t1", Gen: 2, Cause: AttemptCause{Kind: "retry"}},
		Previous: prev, Report: rep})
	waitFailed(t, rep)
	if rep.failed[0].Code != "config_changed" || rep.failed[0].Message == "" {
		t.Fatalf("expected config_changed with message, got %+v", rep.failed[0])
	}
	if f.sendCount() != 0 {
		t.Fatal("must never send to the old carrier after the preset switched agents")
	}
	if len(f.createdTabs()) != 0 {
		t.Fatal("must not replace the carrier either; work must stay where it is")
	}
}

// 续跑时同一 agent 但来源 / 账号 / 模型 / 思考深度变了：停下，不把新配置发到旧标签（含显式空串与默认模型）
func TestCliPresetCarrierConfigChangedFailsSafely(t *testing.T) {
	cases := []struct {
		name     string
		snapshot ExecutionSnapshot
	}{
		{"local->official", ExecutionSnapshot{Cli: sp("codex"), Source: sp("local")}},
		{"account", ExecutionSnapshot{Cli: sp("codex"), Source: sp("official"), AccountID: sp("acct-other")}},
		{"model-default->explicit", ExecutionSnapshot{Cli: sp("codex"), Source: sp("official"), AccountID: sp("acct-codex"), Model: sp("")}},
		{"effort", ExecutionSnapshot{Cli: sp("codex"), Source: sp("official"), AccountID: sp("acct-codex"), Model: sp("gpt-6.1-sol"), ReasoningEffort: sp("low")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, f := presetExecutor(t, map[string]bool{"codex": true}, map[string]*CliPresetSpec{
				"balanced": {Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol", ReasoningEffort: "high"},
			}, nil)
			f.tabs["tab_old"] = &fakeCliTab{cwd: "/repo"}
			prev := &Attempt{ID: "att0", TaskID: "t1", Gen: 1, Snapshot: tc.snapshot,
				Carrier: &Carrier{TabID: sp("tab_old"), Cwd: sp("/repo"), SourceCwd: sp("/repo")}}
			rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
			e.Start(AttemptContext{Task: presetOnlyTask(), Attempt: Attempt{ID: "att2", TaskID: "t1", Gen: 2, Cause: AttemptCause{Kind: "retry"}},
				Previous: prev, Report: rep})
			waitFailed(t, rep)
			if rep.failed[0].Code != "config_changed" || f.sendCount() != 0 || len(f.createdTabs()) != 0 {
				t.Fatalf("changed config must not reuse old carrier: failed=%+v sends=%d tabs=%d", rep.failed[0], f.sendCount(), len(f.createdTabs()))
			}
		})
	}
}

// 旧快照没记来源 / 账号 / 模型 / 深度（nil）：兼容，不比较，照常续跑；空串是已知值，要比
func TestCliCarrierSnapshotKnownEmptyVsUnknown(t *testing.T) {
	if !sameSnapshotValue(nil, "official") || sameSnapshotValue(sp(""), "official") || !sameSnapshotValue(sp("official"), "official") {
		t.Fatal("sameSnapshotValue must treat nil as unknown and empty string as a known value")
	}
}

// 续跑且还是同一个 agent / 来源 / 账号 / 模型：照常续跑同一个标签
func TestCliPresetCarrierSameConfigContinues(t *testing.T) {
	e, f := presetExecutor(t, map[string]bool{"codex": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "codex", Source: "official", AccountID: "acct-codex", Model: "gpt-6.1-sol"},
	}, nil)
	f.tabs["tab_old"] = &fakeCliTab{cwd: "/repo"}
	task := presetOnlyTask()
	prev := &Attempt{ID: "att0", TaskID: "t1", Gen: 1,
		Snapshot: ExecutionSnapshot{Cli: sp("codex"), Source: sp("official"), AccountID: sp("acct-codex"), Model: sp("gpt-6.1-sol")},
		Carrier:  &Carrier{TabID: sp("tab_old"), Cwd: sp("/repo"), SourceCwd: sp("/repo")}}
	rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
	e.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att2", TaskID: "t1", Gen: 2, Cause: AttemptCause{Kind: "retry"}},
		Previous: prev, Report: rep})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && f.sendCount() == 0 {
		time.Sleep(2 * time.Millisecond)
	}
	if rep.failedCode() != "" || f.sendCount() != 1 || f.sendTabs[0] != "tab_old" || len(f.createdTabs()) != 0 {
		t.Fatalf("same config should continue on old tab: failed=%v sends=%v", rep.failed, f.sendTabs)
	}
	f.finish("done")
}

// 档位当前指向未安装的 agent：失败并提示，不开标签
func TestCliPresetResolvedCliUnavailable(t *testing.T) {
	e, f := presetExecutor(t, map[string]bool{"claude": true}, map[string]*CliPresetSpec{
		"balanced": {Cli: "gemini"},
	}, nil)
	task := Task{ID: "t1", Goal: "g", Executor: ExecutorSpec{Kind: "cli", Cli: sp("claude"), PresetID: sp("balanced"), Cwd: sp("/repo")}}
	if _, err := e.Prepare(task); err == nil || !strings.Contains(err.Message, "Gemini") && err.Code != "config_changed" {
		t.Fatalf("Prepare should reject unavailable preset cli, got %+v", err)
	}
	rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
	e.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att1", TaskID: "t1", Gen: 1}, Report: rep})
	waitFailed(t, rep)
	if len(f.createdTabs()) != 0 {
		t.Fatal("must not create a tab for unavailable cli")
	}
}

func presetOnlyTask() Task {
	return Task{ID: "t1", Goal: "g", Executor: ExecutorSpec{Kind: "cli", PresetID: sp("balanced"), Cwd: sp("/repo")}}
}

// 后台任务使用预设且显式指定了模型或思考深度时：显式字段覆盖预设，未指定字段保留预设值；
// 若预设被编辑切换到另一 CLI，则不把旧 CLI 的模型误用到新 CLI 上。
func TestCliPresetExplicitModelAndEffortOverrides(t *testing.T) {
	presets := map[string]*CliPresetSpec{
		"high": {
			Cli:             "claude",
			Source:          "official",
			AccountID:       "acc-1",
			Model:           "claude-opus-4-6",
			ReasoningEffort: "high",
		},
	}

	cases := []struct {
		name       string
		ex         ExecutorSpec
		wantCli    string
		wantModel  string
		wantEffort string
	}{
		{
			name:       "preset + explicit model only",
			ex:         ExecutorSpec{Kind: "cli", Cli: sp("claude"), PresetID: sp("high"), Cwd: sp("/repo"), Model: sp("claude-sonnet-4-6")},
			wantCli:    "claude",
			wantModel:  "claude-sonnet-4-6",
			wantEffort: "high",
		},
		{
			name:       "preset + explicit reasoningEffort only",
			ex:         ExecutorSpec{Kind: "cli", Cli: sp("claude"), PresetID: sp("high"), Cwd: sp("/repo"), ReasoningEffort: sp("low")},
			wantCli:    "claude",
			wantModel:  "claude-opus-4-6",
			wantEffort: "low",
		},
		{
			name:       "preset + explicit model and reasoningEffort",
			ex:         ExecutorSpec{Kind: "cli", Cli: sp("claude"), PresetID: sp("high"), Cwd: sp("/repo"), Model: sp("claude-sonnet-4-6"), ReasoningEffort: sp("low")},
			wantCli:    "claude",
			wantModel:  "claude-sonnet-4-6",
			wantEffort: "low",
		},
		{
			name:       "preset only follows preset",
			ex:         ExecutorSpec{Kind: "cli", PresetID: sp("high"), Cwd: sp("/repo")},
			wantCli:    "claude",
			wantModel:  "claude-opus-4-6",
			wantEffort: "high",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, f := presetExecutor(t, map[string]bool{"claude": true, "codex": true}, presets, nil)
			snap, err := e.Prepare(Task{ID: "t1", Goal: "g", Executor: tc.ex})
			if err != nil {
				t.Fatalf("Prepare error: %+v", err)
			}
			if snap.Cli == nil || *snap.Cli != tc.wantCli ||
				snap.Model == nil || *snap.Model != tc.wantModel {
				t.Fatalf("Prepare snapshot = (%v, %v), want (%s, %s)",
					snap.Cli, snap.Model, tc.wantCli, tc.wantModel)
			}

			rep := &failReporter{beatReporter: beatReporter{completed: make(chan AttemptResult, 4)}}
			e.Start(AttemptContext{Task: Task{ID: "t1", Goal: "g", Executor: tc.ex}, Attempt: Attempt{ID: "att1", TaskID: "t1", Gen: 1}, Report: rep})
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) && f.sendCount() == 0 {
				time.Sleep(2 * time.Millisecond)
			}
			tabs := f.createdTabs()
			if len(tabs) != 1 {
				t.Fatalf("expected 1 created tab, got %d (failed=%v)", len(tabs), rep.failed)
			}
			if tabs[0].Backend != tc.wantCli || tabs[0].ModelOverride != tc.wantModel || tabs[0].ReasoningEffort != tc.wantEffort {
				t.Fatalf("CreateTab = %+v, want backend=%s model=%s effort=%s", tabs[0], tc.wantCli, tc.wantModel, tc.wantEffort)
			}
			f.finish("done")
		})
	}

	// 预设从 claude 改成了 codex：旧 claude 快照上的 model/effort 不应错配到 codex
	presets["high"] = &CliPresetSpec{
		Cli:             "codex",
		Source:          "official",
		AccountID:       "acc-codex",
		Model:           "gpt-5.4",
		ReasoningEffort: "medium",
	}
	spec, ok := ResolveTaskRunSpec(func(id string) *CliPresetSpec { return presets[id] }, &ExecutorSpec{
		Kind:            "cli",
		Cli:             sp("claude"),
		PresetID:        sp("high"),
		Model:           sp("claude-sonnet-4-6"),
		ReasoningEffort: sp("low"),
	})
	if !ok || spec.Cli != "codex" || spec.Model != "gpt-5.4" || spec.ReasoningEffort != "medium" {
		t.Fatalf("changed preset CLI should not inherit stale explicit overrides: %+v ok=%v", spec, ok)
	}
}
