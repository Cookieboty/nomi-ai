package resourcepreview

import (
	"os"
	"path/filepath"
	"testing"
)

// 链接跳到同一项目的附加文件夹：不要求逐个文件授权，可以编辑，保存回到附加文件夹
func TestPreviewProjectFolderNeedsNoConsentAndIsEditable(t *testing.T) {
	dir := t.TempDir()
	primary, extra, other := filepath.Join(dir, "app"), filepath.Join(dir, "docs"), filepath.Join(dir, "other")
	for _, d := range []string{primary, extra, other} {
		_ = os.Mkdir(d, 0o700)
	}
	inExtra := filepath.Join(extra, "plan.md")
	inOther := filepath.Join(other, "x.md")
	_ = os.WriteFile(inExtra, []byte("# plan\n"), 0o600)
	_ = os.WriteFile(inOther, []byte("# x\n"), 0o600)
	s := New()
	s.ProjectRoots = func(path string) []string {
		real := func(d string) string { r, _ := filepath.EvalSymlinks(d); return r }
		if r := real(extra); filepath.Dir(path) == r {
			return []string{real(primary), r}
		}
		return nil
	}
	res := s.Open(primary, inExtra, "/nonexistent-home", false)
	if !res.OK || !res.Editable || res.Code == "authorization" {
		t.Fatalf("project folder file: %+v", res)
	}
	saved := s.Save(res.URL, res.Revision, "# plan v2\n")
	if !saved.OK {
		t.Fatalf("save: %+v", saved)
	}
	if b, _ := os.ReadFile(inExtra); string(b) != "# plan v2\n" {
		t.Fatalf("content %q", b)
	}
	// 不在任何项目里的仍要逐个文件授权；授权后只读
	if r := s.Open(primary, inOther, "/nonexistent-home", false); r.Code != "authorization" {
		t.Fatalf("outside project: %+v", r)
	}
	if r := s.Open(primary, inOther, "/nonexistent-home", true); !r.OK || r.Editable {
		t.Fatalf("consented outside file: %+v", r)
	}
}
