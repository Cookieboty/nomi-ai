package projects

import (
	"os"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) (*Store, string, *[]int) {
	t.Helper()
	dir := t.TempDir()
	emits := []int{}
	s := New(Deps{
		File: filepath.Join(dir, "projects.json"),
		Check: func(d string) (string, string) {
			if st, err := os.Stat(d); err != nil || !st.IsDir() {
				return "", "missing"
			}
			r, _ := filepath.EvalSymlinks(d)
			return r, ""
		},
		Emit: func(l []View) { emits = append(emits, len(l)) },
		Now:  func() int64 { return 1 },
	})
	return s, dir, &emits
}

func mk(t *testing.T, parts ...string) string {
	t.Helper()
	p := filepath.Join(parts...)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	r, _ := filepath.EvalSymlinks(p)
	return r
}

func TestCreateUpdateRemove(t *testing.T) {
	s, dir, emits := newStore(t)
	app, api, docs := mk(t, dir, "app"), mk(t, dir, "api"), mk(t, dir, "docs")
	v, err := s.Create("", app, []string{api, api, app})
	if err != nil {
		t.Fatal(err)
	}
	if v.Name != "app" || v.Primary != app || len(v.Folders) != 1 || v.Folders[0] != api {
		t.Fatalf("dedupe / default name: %+v", v)
	}
	r := s.Roots(v.ID)
	if r.Primary != app || len(r.Extra) != 1 {
		t.Fatalf("roots %+v", r)
	}
	if !s.Contains(filepath.Join(api, "x")) || s.Contains(dir) {
		t.Fatal("Contains")
	}
	changed := ""
	s.OnChange(func(id string) { changed = id })
	name := "跨端"
	v, err = s.Update(v.ID, &name, &api, []string{app, docs}, true)
	if err != nil || v.Primary != api || len(v.Folders) != 2 || v.Name != "跨端" || changed != v.ID {
		t.Fatalf("update: %+v %v changed=%q", v, err, changed)
	}
	// 落盘后重新读
	s2 := New(Deps{File: filepath.Join(dir, "projects.json")})
	if p, ok := s2.Get(v.ID); !ok || p.Primary != api || !s2.Existed() {
		t.Fatalf("reload: %+v", p)
	}
	if err := s.Remove(v.ID); err != nil || len(s.List()) != 0 {
		t.Fatal("remove", err)
	}
	if err := s.Remove("nope"); err != ErrNotFound {
		t.Fatal("remove missing", err)
	}
	if len(*emits) != 3 {
		t.Fatalf("emits %v", *emits)
	}
}

func TestRejectsNestedAndMissing(t *testing.T) {
	s, dir, _ := newStore(t)
	app := mk(t, dir, "app")
	sub := mk(t, dir, "app", "web")
	if _, err := s.Create("", app, []string{sub}); err == nil {
		t.Fatal("nested folders should be rejected")
	}
	var fe *FolderError
	_, err := s.Create("", filepath.Join(dir, "gone"), nil)
	if err == nil || !asFolderErr(err, &fe) || fe.Reason != "missing" {
		t.Fatalf("missing primary: %v", err)
	}
}

func asFolderErr(err error, out **FolderError) bool {
	fe, ok := err.(*FolderError)
	*out = fe
	return ok
}

func TestRootsSkipsMissingExtra(t *testing.T) {
	s, dir, _ := newStore(t)
	app, api := mk(t, dir, "app"), mk(t, dir, "api")
	v, _ := s.Create("x", app, []string{api})
	_ = os.RemoveAll(api)
	r := s.Roots(v.ID)
	if r.Primary != app || len(r.Extra) != 0 {
		t.Fatalf("roots %+v", r)
	}
	if l := s.List(); len(l[0].Missing) != 1 {
		t.Fatalf("missing %+v", l[0])
	}
	_ = os.RemoveAll(app)
	if !s.Roots(v.ID).Empty() {
		t.Fatal("missing primary → empty roots")
	}
}

func TestSeedIdempotent(t *testing.T) {
	s, dir, _ := newStore(t)
	a, b := mk(t, dir, "a"), mk(t, dir, "b")
	gone := filepath.Join(dir, "gone")
	m, err := s.Seed([]string{a, b, a, gone, ""})
	if err != nil || len(m) != 2 || m[a] == "" || m[a] == m[b] || len(s.List()) != 2 {
		t.Fatalf("seed %v %v", m, err)
	}
	// 重跑复用同主文件夹的项目；之前不能用的目录回来了就补建
	mk(t, dir, "gone")
	m2, err := s.Seed([]string{a, gone})
	if err != nil || m2[a] != m[a] || m2[gone] == "" || len(s.List()) != 3 {
		t.Fatalf("reseed %v %v", m2, err)
	}
	// 没有旧目录也落盘（之后不再迁移）
	s3, _, _ := newStore(t)
	if _, err := s3.Seed(nil); err != nil || !s3.Existed() {
		t.Fatal("empty seed should still mark migrated")
	}
}

// FindContaining：目录在哪个项目里；几个项目都包含时取最具体的；不在任何项目里返回 false
func TestFindContaining(t *testing.T) {
	s, dir, _ := newStore(t)
	outer, inner, docs := mk(t, dir, "ai"), mk(t, dir, "ai", "app"), mk(t, dir, "docs")
	a, err := s.Create("", outer, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create("", inner, []string{docs})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		dir  string
		want string
	}{
		{filepath.Join(outer, "x"), a.ID},
		{filepath.Join(inner, "src"), b.ID},
		{inner, b.ID},
		{filepath.Join(docs, "y"), b.ID},
	} {
		if p, ok := s.FindContaining(c.dir); !ok || p.ID != c.want {
			t.Fatalf("%s: %q %v, want %q", c.dir, p.ID, ok, c.want)
		}
	}
	if _, ok := s.FindContaining(mk(t, dir, "other")); ok {
		t.Fatal("outside every project")
	}
	if _, ok := s.FindContaining(""); ok {
		t.Fatal("empty dir")
	}
}
