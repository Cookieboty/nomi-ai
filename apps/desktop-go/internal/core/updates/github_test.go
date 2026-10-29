package updates

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		w    int
	}{{"2.0.5", "2.0.4", 1}, {"2.0.5", "2.0.5", 0}, {"v2.1.0", "2.0.9", 1}, {"2.0.5-beta.1", "2.0.5", -1}, {"2.0.10", "2.0.9", 1}} {
		if g := CompareVersions(c.a, c.b); g != c.w {
			t.Errorf("%s vs %s = %d", c.a, c.b, g)
		}
	}
}

func TestGitHubUpdater(t *testing.T) {
	body := []byte("installer-bytes")
	sum := sha256.Sum256(body)
	status, sha := 200, hex.EncodeToString(sum[:])
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest-go.json":
			if status != 200 {
				w.WriteHeader(status)
				return
			}
			fmt.Fprintf(w, `{"schemaVersion":1,"version":"2.0.6","tag":"v2.0.6","platforms":{"k":{"file":"Nomi.AppImage","url":"%s/f","size":%d,"sha256":"%s"}}}`, srv.URL, len(body), sha)
		case "/f":
			w.Write(body)
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	g := &GitHubUpdater{URL: srv.URL + "/latest-go.json", Version: func() string { return "2.0.5" }, CacheDir: dir, PlatformKey: func() string { return "k" }}
	var log []string
	g.On(UpdaterEvents{
		CheckingForUpdate:  func() { log = append(log, "checking") },
		UpdateAvailable:    func(i UpdateInfo) { log = append(log, "available "+i.Version+" "+*i.ReleaseName.V) },
		UpdateNotAvailable: func() { log = append(log, "none") },
		DownloadProgress:   func(p ProgressInfo) { log = append(log, fmt.Sprintf("progress %.0f", p.Percent)) },
		UpdateDownloaded:   func(i UpdateInfo) { log = append(log, "downloaded") },
	})
	if _, err := g.CheckForUpdates(); err != nil {
		t.Fatal(err)
	}
	if err := g.DownloadUpdate(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Nomi.AppImage")); string(b) != string(body) {
		t.Fatalf("file %q", b)
	}
	want := "[checking available 2.0.6 v2.0.6 progress 100 downloaded]"
	if fmt.Sprint(log) != want {
		t.Fatalf("log %v", log)
	}
	// 缓存命中：不再下载
	log = nil
	if err := g.DownloadUpdate(); err != nil || fmt.Sprint(log) != "[downloaded]" {
		t.Fatalf("cached %v %v", err, log)
	}
	// sha 不符
	os.Remove(filepath.Join(dir, "Nomi.AppImage"))
	sha = "00"
	g.CheckForUpdates()
	if err := g.DownloadUpdate(); err == nil {
		t.Fatal("want checksum error")
	}
	// 同版本
	g.Version = func() string { return "2.0.6" }
	log = nil
	g.CheckForUpdates()
	if fmt.Sprint(log) != "[checking none]" {
		t.Fatalf("same %v", log)
	}
	// 清单缺失 → 发布中
	status = 404
	if _, err := g.CheckForUpdates(); !IsMissingUpdateMetadata(err) {
		t.Fatalf("404 %v", err)
	}
	if err := (&GitHubUpdater{}).QuitAndInstall(false, true); err == nil {
		t.Fatal("install without download")
	}
}
