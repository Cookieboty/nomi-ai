package characterassets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// 与 Node 版 tests/unit/character/CharacterAssets.test.ts 同样的场景

type fakeRemote struct {
	mu      sync.Mutex
	files   map[string][]byte
	rive    string
	corrupt bool
	hang    bool
	hits    []string
	srv     *httptest.Server
}

func newRemote(t *testing.T, files map[string][]byte, rive string) *fakeRemote {
	r := &fakeRemote{files: files, rive: rive}
	r.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.hits = append(r.hits, req.URL.Path)
		rive, corrupt, hang := r.rive, r.corrupt, r.hang
		r.mu.Unlock()
		if req.URL.Path == "/catalog.json" {
			b := r.files[rive]
			sum := sha256.Sum256(b)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"schemaVersion": 1,
				"packs": []any{map[string]any{"id": "nomi", "version": "1.0.0", "assets": map[string]any{
					"rive": map[string]any{"file": rive, "url": r.srv.URL + "/" + rive, "size": len(b), "sha256": hex.EncodeToString(sum[:])},
				}}},
			})
			return
		}
		if hang {
			<-req.Context().Done()
			return
		}
		b, ok := r.files[strings.TrimPrefix(req.URL.Path, "/")]
		if !ok {
			http.NotFound(w, req)
			return
		}
		if corrupt {
			b = bytes.Repeat([]byte{1}, len(b))
		}
		w.Write(b)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *fakeRemote) setRive(v string) { r.mu.Lock(); r.rive = v; r.mu.Unlock() }
func (r *fakeRemote) resetHits()       { r.mu.Lock(); r.hits = nil; r.mu.Unlock() }
func (r *fakeRemote) hitList() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.hits...)
}

type recorder struct {
	mu     sync.Mutex
	events []State
}

func (rc *recorder) publish(s State) { rc.mu.Lock(); rc.events = append(rc.events, s); rc.mu.Unlock() }
func (rc *recorder) statuses() []string {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	out := []string{}
	for _, e := range rc.events {
		out = append(out, e.Status)
	}
	return out
}

func newSvc(root string, r *fakeRemote, rc *recorder, remote []string) *Service {
	return New(Options{
		Root:       root,
		Active:     func() *ActivePack { return &ActivePack{ID: "nomi", Rive: "rive/character.riv", Remote: remote} },
		Publish:    rc.publish,
		Client:     r.srv.Client(),
		CatalogURL: r.srv.URL + "/catalog.json",
	})
}

var (
	v1 = bytes.Repeat([]byte("rive v1 "), 4000)
	v2 = bytes.Repeat([]byte("rive v2 "), 5000)
)

func shaHex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func TestDownloadThenCache(t *testing.T) {
	root := t.TempDir()
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1}, "nomi-rive-aaa.riv")
	rc := &recorder{}
	a := newSvc(root, r, rc, []string{"rive"})
	if s := a.State(); s.Status != "idle" || !s.Remote || deref(s.PackID) != "nomi" {
		t.Fatalf("initial = %+v", s)
	}
	s := a.Ensure()
	if s.Status != "ready" || deref(s.Version) != shaHex(v1)[:12] || deref(s.RiveURL) != "character-pack://assets/nomi/nomi-rive-aaa.riv" {
		t.Fatalf("after ensure = %+v", s)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "nomi", "nomi-rive-aaa.riv")); !bytes.Equal(b, v1) {
		t.Fatal("downloaded file differs")
	}
	got := strings.Join(rc.statuses(), ",")
	for _, want := range []string{"checking", "downloading", "ready"} {
		if !strings.Contains(got, want) {
			t.Fatalf("events %s missing %s", got, want)
		}
	}
	// 下次启动：直接就绪；同一版本只读目录
	b := newSvc(root, r, &recorder{}, []string{"rive"})
	if b.State().Status != "ready" {
		t.Fatalf("restart = %+v", b.State())
	}
	r.resetHits()
	b.Ensure()
	if h := r.hitList(); len(h) != 1 || h[0] != "/catalog.json" {
		t.Fatalf("hits = %v", h)
	}
}

func TestNewVersionReplacesOld(t *testing.T) {
	root := t.TempDir()
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1, "nomi-rive-bbb.riv": v2}, "nomi-rive-aaa.riv")
	a := newSvc(root, r, &recorder{}, []string{"rive"})
	a.Ensure()
	r.setRive("nomi-rive-bbb.riv")
	rc := &recorder{}
	a.o.Publish = rc.publish
	s := a.Ensure()
	if deref(s.RiveURL) != "character-pack://assets/nomi/nomi-rive-bbb.riv" {
		t.Fatalf("state = %+v", s)
	}
	for _, st := range rc.statuses() {
		if st != "ready" {
			t.Fatalf("update should stay ready, got %v", rc.statuses())
		}
	}
	ents, _ := os.ReadDir(filepath.Join(root, "nomi"))
	names := []string{}
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "current.json,nomi-rive-bbb.riv" {
		t.Fatalf("files = %v", names)
	}
}

func TestShaMismatch(t *testing.T) {
	root := t.TempDir()
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1}, "nomi-rive-aaa.riv")
	r.corrupt = true
	s := newSvc(root, r, &recorder{}, []string{"rive"}).Ensure()
	if s.Status != "error" || !strings.Contains(deref(s.Error), "sha256") {
		t.Fatalf("state = %+v", s)
	}
	if ents, _ := os.ReadDir(filepath.Join(root, "nomi")); len(ents) != 0 {
		t.Fatalf("left files: %v", ents)
	}
}

func TestOfflineKeepsCache(t *testing.T) {
	root := t.TempDir()
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1}, "nomi-rive-aaa.riv")
	newSvc(root, r, &recorder{}, []string{"rive"}).Ensure()
	r.srv.Close()
	if s := newSvc(root, r, &recorder{}, []string{"rive"}).Ensure(); s.Status != "ready" {
		t.Fatalf("offline with cache = %+v", s)
	}
	os.RemoveAll(filepath.Join(root, "nomi"))
	if s := newSvc(root, r, &recorder{}, []string{"rive"}).Ensure(); s.Status != "error" || s.RiveURL != nil {
		t.Fatalf("offline without cache = %+v", s)
	}
}

func TestPackWithoutRemote(t *testing.T) {
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1}, "nomi-rive-aaa.riv")
	s := newSvc(t.TempDir(), r, &recorder{}, nil).Ensure()
	if s.Remote || s.Status != "idle" || len(r.hitList()) != 0 {
		t.Fatalf("state = %+v hits = %v", s, r.hitList())
	}
}

func TestStalledDownload(t *testing.T) {
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1}, "nomi-rive-aaa.riv")
	r.hang = true
	a := newSvc(t.TempDir(), r, &recorder{}, []string{"rive"})
	a.o.Stall = 50 * time.Millisecond
	s := a.Ensure()
	if s.Status != "error" || !strings.Contains(deref(s.Error), "stalled") {
		t.Fatalf("state = %+v", s)
	}
}

func TestConcurrentEnsureSharesOneRun(t *testing.T) {
	r := newRemote(t, map[string][]byte{"nomi-rive-aaa.riv": v1}, "nomi-rive-aaa.riv")
	a := newSvc(t.TempDir(), r, &recorder{}, []string{"rive"})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); a.Ensure() }()
	}
	wg.Wait()
	downloads := 0
	for _, h := range r.hitList() {
		if h == "/nomi-rive-aaa.riv" {
			downloads++
		}
	}
	if downloads != 1 || a.State().Status != "ready" {
		t.Fatalf("downloads = %d state = %+v", downloads, a.State())
	}
}
