package diagnostics

import (
	"os"
	"path/filepath"
	"testing"
)

func newSvc(t *testing.T, dir string, levels *[]bool) *Service {
	t.Helper()
	f := false
	return New(Deps{UserData: dir, Dev: &f, SetLevel: func(d bool) { *levels = append(*levels, d) }})
}

// 没有 diagnostics.json：诊断默认开着（正文追踪），但日志保持 INFO；用户主动打开后才转 DEBUG
func TestDefaultOnKeepsInfoLevelUntilExplicit(t *testing.T) {
	t.Setenv("NODE_ENV", "")
	t.Setenv("NOMI_DIAG_BODY", "")
	dir := t.TempDir()
	var levels []bool
	s := newSvc(t, dir, &levels)
	if !s.Enabled() || !s.BodyTrace() {
		t.Fatal("expected diagnostics on by default")
	}
	if levels[len(levels)-1] {
		t.Fatal("default-on must not switch the logger to DEBUG")
	}
	s.Set(true) // 已经开着，再点打开 = 主动打开
	if !levels[len(levels)-1] {
		t.Fatal("explicit opt-in should enable DEBUG")
	}
	if _, err := os.Stat(filepath.Join(dir, "diagnostics.json")); err != nil {
		t.Fatal("explicit opt-in should be persisted")
	}
	levels = nil
	s2 := newSvc(t, dir, &levels)
	if !levels[len(levels)-1] {
		t.Fatal("persisted opt-in should keep DEBUG after restart")
	}
	s2.Set(false)
	if s2.Enabled() || levels[len(levels)-1] {
		t.Fatal("turning off should disable diagnostics and DEBUG")
	}
}
