package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRepairDshPatchFile(t *testing.T) {
	d := t.TempDir()
	read := func(p string) string { b, _ := os.ReadFile(p); return string(b) }
	// 空文件 / 只有注释：补成顶层空数组，注释保留
	empty := filepath.Join(d, "a.yml")
	_ = os.WriteFile(empty, nil, 0o644)
	if !RepairDshPatchFile(empty) || read(empty) != "[]\n" {
		t.Fatalf("empty: %q", read(empty))
	}
	comment := filepath.Join(d, "b.yml")
	_ = os.WriteFile(comment, []byte("# my notes\n\n"), 0o644)
	if !RepairDshPatchFile(comment) || read(comment) != "# my notes\n[]\n" {
		t.Fatalf("comment: %q", read(comment))
	}
	// 有内容 / 不存在：不动
	ok := filepath.Join(d, "c.yml")
	_ = os.WriteFile(ok, []byte("- id: llm-pi-ai\n"), 0o644)
	if RepairDshPatchFile(ok) || read(ok) != "- id: llm-pi-ai\n" {
		t.Fatalf("valid: %q", read(ok))
	}
	if RepairDshPatchFile(filepath.Join(d, "missing.yml")) {
		t.Fatal("missing file should be false")
	}
}

func TestDshPatchPath(t *testing.T) {
	t.Setenv("DSH_HOME", "")
	if got := DshPatchPath("/h"); got != filepath.Join("/h", ".dsh", "cordis.patch.yml") {
		t.Fatal(got)
	}
	t.Setenv("DSH_HOME", " /custom/dsh ")
	abs, _ := filepath.Abs("/custom/dsh")
	if got := DshPatchPath("/h"); got != filepath.Join(abs, "cordis.patch.yml") {
		t.Fatal(got)
	}
}
