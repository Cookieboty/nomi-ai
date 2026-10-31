package updates

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// packaging/update-manifest.py 产出的 latest-go.json 必须能被 GitHubUpdater 解析（D-B11-3）。
func TestUpdateManifestScriptParses(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not found")
	}
	const v = "2.0.5"
	dir := t.TempDir()
	files := []string{"Nomi-" + v + "-arm64.dmg", "Nomi-" + v + ".dmg", "Nomi-Setup-" + v + ".exe",
		"Nomi-" + v + ".AppImage", "nomi_" + v + "_amd64.deb", "Nomi-" + v + "-arm64-mac.zip", "Nomi-" + v + "-mac.zip"}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("payload "+f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	notes := filepath.Join(t.TempDir(), "v"+v+".md")
	if err := os.WriteFile(notes, []byte("# Nomi "+v+"\n\n- 修复 / Fixed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	script := paritytest.RepoPath("apps/desktop-go/packaging/update-manifest.py")
	if out, err := exec.Command(py, script, v, dir, "--notes", notes).CombinedOutput(); err != nil {
		t.Fatalf("update-manifest.py: %v\n%s", err, out)
	}
	m := checkManifest(t, filepath.Join(dir, "latest-go.json"), dir)
	if m.ReleaseNotes != "# Nomi "+v+"\n\n- 修复 / Fixed" {
		t.Fatalf("releaseNotes = %q", m.ReleaseNotes)
	}
	// 给了 --notes 但文件不存在：失败，不能发出没有说明的清单
	if err := exec.Command(py, script, v, dir, "--notes", filepath.Join(dir, "missing.md")).Run(); err == nil {
		t.Fatal("missing notes file should fail")
	}
}

// CI manifest 任务：NOMI_LATEST_GO_JSON 指向真实产物生成的 latest-go.json（同目录有安装包）。
func TestUpdateManifestReleaseFile(t *testing.T) {
	p := os.Getenv("NOMI_LATEST_GO_JSON")
	if p == "" {
		t.Skip("NOMI_LATEST_GO_JSON not set")
	}
	if m := checkManifest(t, p, filepath.Dir(p)); m.ReleaseNotes == "" {
		t.Fatal("release latest-go.json has no releaseNotes (docs/releases/v<version>.md)")
	}
}

func checkManifest(t *testing.T, path, dir string) manifest {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse: %v", err)
	}
	v := m.Version
	if m.SchemaVersion != 1 || v == "" || m.Tag != "v"+v {
		t.Fatalf("header: %+v", m)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write(raw) }))
	defer srv.Close()
	for _, key := range []string{"darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64", "linux-amd64-deb"} {
		e, ok := m.Platforms[key]
		if !ok {
			t.Fatalf("missing platform %s", key)
		}
		f, err := os.Open(filepath.Join(dir, e.File))
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.New()
		n, _ := io.Copy(h, f)
		f.Close()
		if e.Sha256 != hex.EncodeToString(h.Sum(nil)) || e.Size != n || e.URL != "https://github.com/Cookieboty/nomi-ai/releases/download/"+m.Tag+"/"+e.File {
			t.Fatalf("%s entry wrong: %+v", key, e)
		}
		k := key
		g := &GitHubUpdater{URL: srv.URL, Version: func() string { return "2.0.4" }, PlatformKey: func() string { return k }, CacheDir: t.TempDir()}
		if _, err := g.CheckForUpdates(); err != nil {
			t.Fatalf("%s: CheckForUpdates: %v", key, err)
		}
		g.mu.Lock()
		p, info := g.pending, g.info
		g.mu.Unlock()
		if p == nil || p.File != e.File {
			t.Fatalf("%s: pending = %+v", key, p)
		}
		if m.ReleaseNotes != "" && info.ReleaseNotes != m.ReleaseNotes {
			t.Fatalf("%s: releaseNotes not passed to UpdateInfo: %v", key, info.ReleaseNotes)
		}
	}
	return m
}
