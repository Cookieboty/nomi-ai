package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

func migrationStore(userData string) *projects.Store {
	return projects.New(projects.Deps{
		File: filepath.Join(userData, "projects.json"),
		Check: func(d string) (string, string) {
			if st, err := os.Stat(d); err != nil || !st.IsDir() {
				return "", "missing"
			}
			r, _ := filepath.EvalSymlinks(d)
			return r, ""
		},
		Inside: func(c, p string) bool {
			r, err := filepath.Rel(p, c)
			return err == nil && filepath.IsLocal(r) || r == "."
		},
		Now: func() int64 { return 1 },
	})
}

func convMetas(t *testing.T, conv *convstore.Store) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	if _, err := conv.RewriteMetas(func(m map[string]any) bool { out = append(out, m); return false }); err != nil {
		t.Fatal(err)
	}
	return out
}

func putConv(t *testing.T, conv *convstore.Store, meta map[string]any) {
	t.Helper()
	b, _ := json.Marshal(meta)
	if _, err := conv.Put(b, nil, nil); err != nil {
		t.Fatal(err)
	}
}

// 目录此刻不能用（外接盘没挂）：对话保留 cwd，不丢绑定；目录回来后下次启动补迁
func TestMigrateKeepsUnavailableWorkspace(t *testing.T) {
	userData, work := t.TempDir(), t.TempDir()
	here, disk := filepath.Join(work, "here"), filepath.Join(work, "disk")
	_ = os.Mkdir(here, 0o700)
	conv := convstore.New(userData)
	putConv(t, conv, map[string]any{"id": "a", "cwd": here})
	putConv(t, conv, map[string]any{"id": "b", "cwd": disk})

	s := migrationStore(userData)
	migrateToProjects(s, userData, conv, nil, nil)
	ms := convMetas(t, conv)
	if ms[0]["projectId"] == nil || ms[0]["cwd"] != nil {
		t.Fatalf("available dir migrated: %v", ms[0])
	}
	if ms[1]["cwd"] != disk || ms[1]["projectId"] != nil {
		t.Fatalf("unavailable dir keeps its binding: %v", ms[1])
	}
	if _, err := os.Stat(filepath.Join(userData, migrationPendingFile)); !os.IsNotExist(err) {
		t.Fatal("migration should be marked done")
	}

	_ = os.Mkdir(disk, 0o700)
	conv = convstore.New(userData)
	s = migrationStore(userData)
	migrateToProjects(s, userData, conv, nil, nil)
	ms = convMetas(t, conv)
	p, ok := s.Get(ms[1]["projectId"].(string))
	if !ok || p.Primary != disk || ms[1]["cwd"] != nil {
		t.Fatalf("recovered later: %v %+v", ms[1], p)
	}
}

// 建完项目后写对话索引失败：下次启动接着迁（不因为 projects.json 已存在就跳过）
func TestMigrateResumesAfterPartialFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("靠只读目录让写入失败；Windows 上目录的只读属性不拦写文件")
	}
	userData, work := t.TempDir(), t.TempDir()
	conv := convstore.New(userData)
	putConv(t, conv, map[string]any{"id": "a", "cwd": work})
	convDir := filepath.Join(userData, convstore.Dir)
	if err := os.Chmod(convDir, 0o500); err != nil {
		t.Fatal(err)
	}
	s := migrationStore(userData)
	migrateToProjects(s, userData, conv, nil, nil)
	_ = os.Chmod(convDir, 0o700)
	if !s.Existed() {
		t.Fatal("projects.json written before the failing step")
	}
	if _, err := os.Stat(filepath.Join(userData, migrationPendingFile)); err != nil {
		t.Fatal("failed migration stays pending")
	}

	conv = convstore.New(userData)
	s = migrationStore(userData)
	migrateToProjects(s, userData, conv, nil, nil)
	ms := convMetas(t, conv)
	if ms[0]["projectId"] == nil || ms[0]["cwd"] != nil || len(s.List()) != 1 {
		t.Fatalf("resumed: %v %d", ms[0], len(s.List()))
	}
	if _, err := os.Stat(filepath.Join(userData, migrationPendingFile)); !os.IsNotExist(err) {
		t.Fatal("pending mark cleared after success")
	}
}
