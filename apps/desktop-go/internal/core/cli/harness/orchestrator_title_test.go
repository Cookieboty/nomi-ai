package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func titleTestOrch(t *testing.T) *Orchestrator {
	t.Helper()
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	work := filepath.Join(tmp, "work")
	_ = os.MkdirAll(work, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	t.Setenv("NOMI_USE_MOCK_CLI", "1")
	t.Setenv("NOMI_MOCK_DELAY_MS", "10")
	t.Chdir(repoRoot(t))
	idle := 0.0
	return New(Deps{
		Root:             filepath.Join(tmp, "harness"),
		Home:             tmp,
		DefaultCwd:       filepath.Join(tmp, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
}

func awaitSend(t *testing.T, o *Orchestrator, id, prompt string) {
	t.Helper()
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.SendTab(id, prompt, nil, false)
	})
	if _, err := jsrt.Block(p); err != nil {
		t.Fatalf("SendTab: %v", err)
	}
}

func tabTitle(o *Orchestrator, id string) string {
	return str(o.tab(id), "title")
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func TestHeuristicTitleOnFirstSend(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "codex"))
	})
	id := str(tab, "id")
	if tabTitle(o, id) != "Codex" {
		t.Fatalf("title=%q want Codex", tabTitle(o, id))
	}
	awaitSend(t, o, id, "修复登录流程里的空指针")
	got := tabTitle(o, id)
	if !strings.HasPrefix(got, "修复登录流程") {
		t.Fatalf("title=%q want prefix 修复登录流程", got)
	}
	if utf16Len(got) > 60 {
		t.Fatalf("title len=%d > 60 (%q)", utf16Len(got), got)
	}
}

func TestHeuristicTitleSkipsManualRename(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "codex"))
	})
	id := str(tab, "id")
	jsrt.Run(func() { o.RenameTab(id, "我的 Codex") })
	awaitSend(t, o, id, "这段不该改标题")
	if got := tabTitle(o, id); got != "我的 Codex" {
		t.Fatalf("title=%q want 我的 Codex", got)
	}
}

func TestApplyAutoTitlePendingGate(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)

	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "claude"))
	})
	id := str(tab, "id")
	awaitSend(t, o, id, "帮我写一个解析器")

	applied := jsrt.Call(func() *util.Obj { return o.ApplyAutoTitle(id, "写解析器") })
	if applied == nil || str(applied, "title") != "写解析器" {
		t.Fatalf("ApplyAutoTitle first=%v", applied)
	}
	if second := jsrt.Call(func() *util.Obj { return o.ApplyAutoTitle(id, "第二次") }); second != nil {
		t.Fatalf("second ApplyAutoTitle=%v want nil", second)
	}

	tab2 := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "codex"))
	})
	id2 := str(tab2, "id")
	awaitSend(t, o, id2, "另一段")
	jsrt.Run(func() { o.RenameTab(id2, "手动名") })
	if smart := jsrt.Call(func() *util.Obj { return o.ApplyAutoTitle(id2, "智能名") }); smart != nil {
		t.Fatalf("after rename ApplyAutoTitle=%v want nil", smart)
	}
	if got := tabTitle(o, id2); got != "手动名" {
		t.Fatalf("title=%q want 手动名", got)
	}
}
