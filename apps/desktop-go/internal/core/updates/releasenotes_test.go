package updates

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func notesServer(t *testing.T, hits *int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		switch r.URL.Path {
		case "/v2.0.8/latest-go.json":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": "2.0.8", "releaseDate": "2026-11-02T00:00:00Z",
				"releaseNotes": "# Nomi 2.0.8\n\n- 修复 / Fixed",
			})
		case "/v2.0.7/latest-go.json": // 2.0.8 之前的清单没有 releaseNotes
			_ = json.NewEncoder(w).Encode(map[string]any{"version": "2.0.7"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestNotesFetchCacheAndOffline(t *testing.T) {
	var hits int32
	srv := notesServer(t, &hits)
	dir := t.TempDir()
	n := &Notes{
		Version:  func() string { return "2.0.8" },
		UserData: dir,
		URL:      func(v string) string { return fmt.Sprintf("%s/v%s/latest-go.json", srv.URL, v) },
	}
	got := n.Get("")
	if got.Version != "2.0.8" || got.Notes == nil || !strings.Contains(*got.Notes, "修复 / Fixed") {
		t.Fatalf("first get = %+v", got)
	}
	if got.ReleaseDate == nil || *got.ReleaseDate != "2026-11-02T00:00:00Z" {
		t.Fatalf("releaseDate = %v", got.ReleaseDate)
	}
	if _, err := os.Stat(filepath.Join(dir, "release-notes.json")); err != nil {
		t.Fatalf("cache not written: %v", err)
	}
	// 第二次（以及离线时）读缓存，不再请求
	srv.Close()
	again := n.Get("2.0.8")
	if again.Notes == nil || *again.Notes != *got.Notes || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("cached get = %+v hits=%d", again, hits)
	}
}

func TestNotesMissingOrInvalid(t *testing.T) {
	var hits int32
	srv := notesServer(t, &hits)
	n := &Notes{
		UserData: t.TempDir(),
		URL:      func(v string) string { return fmt.Sprintf("%s/v%s/latest-go.json", srv.URL, v) },
	}
	for _, v := range []string{"2.0.7", "9.9.9"} {
		if r := n.Get(v); r.Version != v || r.Notes != nil {
			t.Fatalf("%s: %+v", v, r)
		}
	}
	// 开发版 / 非法版本号不发请求
	before := atomic.LoadInt32(&hits)
	for _, v := range []string{"0.0.0-dev/../x", "../../etc", "latest"} {
		if r := n.Get(v); r.Notes != nil {
			t.Fatalf("%s: %+v", v, r)
		}
	}
	if atomic.LoadInt32(&hits) != before {
		t.Fatal("invalid versions must not fetch")
	}
}

func TestNotesCacheKeepsRecentVersions(t *testing.T) {
	dir := t.TempDir()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v"), "/latest-go.json")
		_ = json.NewEncoder(w).Encode(map[string]any{"version": v, "releaseNotes": "notes " + v})
	}))
	t.Cleanup(srv.Close)
	var now int64
	n := &Notes{
		UserData: dir,
		URL:      func(v string) string { return fmt.Sprintf("%s/v%s/latest-go.json", srv.URL, v) },
	}
	n.Now = func() time.Time { now++; return time.UnixMilli(now) }
	for i := 1; i <= notesCacheMax+2; i++ {
		n.Get(fmt.Sprintf("2.0.%d", i))
	}
	c := n.load()
	if len(c.Entries) != notesCacheMax {
		t.Fatalf("entries = %d", len(c.Entries))
	}
	if _, ok := c.Entries["2.0.1"]; ok {
		t.Fatal("oldest entry should be dropped")
	}
}
