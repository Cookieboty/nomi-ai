package igtools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// holdUI：确认请求先挂起，由测试决定何时放行（同 tools.test.ts 的 fs_edit 并发用例）
type holdUI struct{ reqs chan desktop.ConfirmRequest }

func (h *holdUI) Request(req desktop.ConfirmRequest) { h.reqs <- req }
func (h *holdUI) Cancel(string)                      {}

type editEnv struct {
	svc  *desktop.Service
	ui   *holdUI
	docs string
	edit tools.Definition
	undo tools.Definition
}

func newEditEnv(t *testing.T) *editEnv {
	t.Helper()
	R := t.TempDir()
	if r, err := filepath.EvalSymlinks(R); err == nil {
		R = r
	}
	H, UD := filepath.Join(R, "home"), filepath.Join(R, "ud")
	docs := filepath.Join(H, "docs")
	_ = os.MkdirAll(docs, 0o755)
	_ = os.MkdirAll(UD, 0o755)
	svc := desktop.CreateService(UD, desktop.Ports{Home: H}, nil)
	svc.Broker.Grant(docs, "read-write", "folder", false)
	ui := &holdUI{reqs: make(chan desktop.ConfirmRequest, 4)}
	svc.Broker.UI = ui
	defs := DesktopTools(DeskDeps{Broker: svc.Broker, Audit: svc.Audit, Journal: svc.Journal, Trash: svc.Trash})
	env := &editEnv{svc: svc, ui: ui, docs: docs}
	for _, d := range defs {
		switch d.Name {
		case "fs_edit":
			env.edit = d
		case "undo_last":
			env.undo = d
		}
	}
	return env
}

func (e *editEnv) call(t *testing.T, d tools.Definition, in string) map[string]any {
	t.Helper()
	v, _ := u.ParseString(in)
	out, err := d.Execute(context.Background(), v, tools.ExecContext{ToolCallID: "tc1"})
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	_ = json.Unmarshal([]byte(u.Stringify(out)), &o)
	return o
}

// approveNext 在另一个协程里放行下一次确认
func (e *editEnv) approveNext() {
	go func() { r := <-e.ui.reqs; e.svc.Broker.Answer(r.ID, true, false) }()
}

func editJSON(p, oldT, newT string) string {
	b, _ := json.Marshal(map[string]any{"path": p, "edits": []any{map[string]any{"oldText": oldT, "newText": newT}}})
	return string(b)
}

func errCode(o map[string]any) string {
	if e, ok := o["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

func readStr(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestFsEditConflictWhileConfirming(t *testing.T) {
	e := newEditEnv(t)
	f := filepath.Join(e.docs, "race.txt")
	_ = os.WriteFile(f, []byte("alpha\nbeta\n"), 0o644)
	done := make(chan map[string]any, 1)
	go func() { done <- e.call(t, e.edit, editJSON(f, "alpha", "ALPHA")) }()
	var req desktop.ConfirmRequest
	select {
	case req = <-e.ui.reqs:
	case <-time.After(5 * time.Second):
		t.Fatal("no confirm request")
	}
	// 确认挂起期间，用户在编辑器里改了另一段并保存
	_ = os.WriteFile(f, []byte("alpha\nbeta (saved by user)\n"), 0o644)
	e.svc.Broker.Answer(req.ID, true, false)
	o := <-done
	if o["ok"] != false || errCode(o) != "conflict" {
		t.Fatalf("want conflict, got %v", o)
	}
	if got := readStr(t, f); got != "alpha\nbeta (saved by user)\n" {
		t.Fatalf("file changed: %q", got)
	}
	if n := len(e.svc.Journal.List(50)); n != 0 {
		t.Fatalf("journal has %d entries", n)
	}
	// 重新读取后再改就正常
	e.approveNext()
	if o := e.call(t, e.edit, editJSON(f, "alpha", "ALPHA")); o["ok"] != true {
		t.Fatalf("retry failed: %v", o)
	}
	if got := readStr(t, f); got != "ALPHA\nbeta (saved by user)\n" {
		t.Fatalf("retry content %q", got)
	}
}

func TestFsEditConflictBetweenRecheckAndMove(t *testing.T) {
	e := newEditEnv(t)
	f := filepath.Join(e.docs, "race2.txt")
	_ = os.WriteFile(f, []byte("one\ntwo\n"), 0o644)
	editBeforeTrash = func(p string) { _ = os.WriteFile(p, []byte("one\ntwo (late save)\n"), 0o644) }
	t.Cleanup(func() { editBeforeTrash = nil })
	e.approveNext()
	o := e.call(t, e.edit, editJSON(f, "one", "ONE"))
	if errCode(o) != "conflict" {
		t.Fatalf("want conflict, got %v", o)
	}
	if got := readStr(t, f); got != "one\ntwo (late save)\n" {
		t.Fatalf("file not put back: %q", got)
	}
}

func TestFsEditBOMAndUndo(t *testing.T) {
	e := newEditEnv(t)
	f := filepath.Join(e.docs, "bom.txt")
	_ = os.WriteFile(f, []byte("\xef\xbb\xbfhello world\n"), 0o644)
	e.approveNext()
	if o := e.call(t, e.edit, editJSON(f, "world", "there")); o["ok"] != true {
		t.Fatalf("edit failed: %v", o)
	}
	if got := readStr(t, f); got != "\xef\xbb\xbfhello there\n" {
		t.Fatalf("got %q", got)
	}
	e.approveNext()
	if o := e.call(t, e.undo, "{}"); o["ok"] != true {
		t.Fatalf("undo failed: %v", o)
	}
	if got := readStr(t, f); got != "\xef\xbb\xbfhello world\n" {
		t.Fatalf("after undo %q", got)
	}
}
