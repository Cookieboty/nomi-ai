package updates

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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

// mac：清单带 update（-mac.zip）且应用可原地替换时下载 zip、安装走替换；不能替换时仍下 dmg、交给系统打开
func TestGitHubUpdaterInPlaceSwap(t *testing.T) {
	dmg, zip := []byte("dmg-bytes"), []byte("zip-bytes")
	sum := func(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest-go.json":
			fmt.Fprintf(w, `{"schemaVersion":1,"version":"2.2.0","tag":"v2.2.0","platforms":{"darwin-arm64":{"file":"Nomi-2.2.0-arm64.dmg","url":"%[1]s/dmg","size":%[2]d,"sha256":"%[3]s","update":{"file":"Nomi-2.2.0-arm64-mac.zip","url":"%[1]s/zip","size":%[4]d,"sha256":"%[5]s"}}}}`,
				srv.URL, len(dmg), sum(dmg), len(zip), sum(zip))
		case "/dmg":
			w.Write(dmg)
		case "/zip":
			w.Write(zip)
		}
	}))
	defer srv.Close()
	for _, swappable := range []bool{true, false} {
		dir := t.TempDir()
		var swapped []string
		quit := false
		g := &GitHubUpdater{
			URL: srv.URL + "/latest-go.json", Version: func() string { return "2.1.2" }, CacheDir: dir,
			PlatformKey: func() string { return "darwin-arm64" },
			SwapTarget:  func() (string, bool) { return "/Applications/Nomi.app", swappable },
			Quit:        func() { quit = true },
		}
		g.startSwap = func(z, b string, relaunch bool) error {
			swapped = append(swapped, filepath.Base(z), b, fmt.Sprint(relaunch))
			return nil
		}
		if _, err := g.CheckForUpdates(); err != nil {
			t.Fatal(err)
		}
		if err := g.DownloadUpdate(); err != nil {
			t.Fatal(err)
		}
		if !swappable {
			// 不能替换：下的是 dmg；安装会 open 它（这里不真的跑安装）
			if _, err := os.Stat(filepath.Join(dir, "Nomi-2.2.0-arm64.dmg")); err != nil {
				t.Fatal("dmg not downloaded", err)
			}
			continue
		}
		if err := g.QuitAndInstall(false, true); err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(swapped) != "[Nomi-2.2.0-arm64-mac.zip /Applications/Nomi.app true]" || !quit {
			t.Fatalf("swap %v quit %v", swapped, quit)
		}
		if _, err := os.Stat(filepath.Join(dir, "Nomi-2.2.0-arm64-mac.zip")); !os.IsNotExist(err) {
			t.Fatal("zip still in the update cache after a successful swap")
		}
	}
}

func TestQuitAndInstallKeepsZipWhenSwapFails(t *testing.T) {
	dir := t.TempDir()
	zip := filepath.Join(dir, "Nomi-2.2.0-arm64-mac.zip")
	if err := os.WriteFile(zip, []byte("zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := &GitHubUpdater{CacheDir: dir, downloaded: "unused"}
	g.mu.Lock()
	g.downloaded = zip
	g.swapBundle = "/Applications/Nomi.app"
	g.mu.Unlock()
	g.startSwap = func(string, string, bool) error { return fmt.Errorf("verify failed") }
	if err := g.QuitAndInstall(false, true); err == nil {
		t.Fatal("want swap error")
	}
	if _, err := os.Stat(zip); err != nil {
		t.Fatal("failed swap must keep the zip", err)
	}
}

func TestAppImageReplaceRemovesCachedCopy(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("AppImage replace only runs on Linux")
	}
	dir := t.TempDir()
	cur := filepath.Join(dir, "Nomi.AppImage")
	if err := os.WriteFile(cur, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(dir, "cache")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	pkg := filepath.Join(cache, "Nomi-2.3.10.AppImage")
	if err := os.WriteFile(pkg, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APPIMAGE", cur)
	if err := installerCommand(pkg, false); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(cur); err != nil || string(b) != "new" {
		t.Fatalf("installed app %q %v", b, err)
	}
	if _, err := os.Stat(pkg); !os.IsNotExist(err) {
		t.Fatal("cached AppImage copy should be removed after replace")
	}
}
