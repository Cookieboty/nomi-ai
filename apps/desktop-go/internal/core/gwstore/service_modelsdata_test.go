package gwstore

import (
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
)

func priceSyncAPI(n int) string {
	var b strings.Builder
	b.WriteString(`{"openai":{"id":"openai","models":{`)
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"m-%03d":{"id":"m-%03d","name":"M %d","cost":{"input":%d,"output":%d},"limit":{"context":%d,"output":4096}}`, i, i, i, 1+i%5, 2+i%7, 100000+i*1000)
	}
	b.WriteString(`}}}`)
	return b.String()
}

// End-to-end: usage.PriceSync wired to the gateway via ModelsDataHooks updates the
// catalog overlay, and needsFull drops If-None-Match until the gateway has a catalog.
func TestModelsDataHooksWithPriceSync(t *testing.T) {
	models.SetCatalogOverlay(nil)
	t.Cleanup(func() { models.SetCatalogOverlay(nil) })
	ud := t.TempDir()
	s := NewService(filepath.Join(ud, "gateway"), fakeCipher{}, nil, nil)
	port := 0
	s.AttachRuntime(RuntimeDeps{Root: filepath.Join(ud, "gateway"), Port: &port, Lazy: true, Env: map[string]string{}})
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	var writes []<-chan struct{}
	t.Cleanup(func() {
		for _, w := range writes {
			<-w
		}
	})
	onData, needsFull := s.modelsDataHooks(func(w <-chan struct{}) { writes = append(writes, w) })
	if pOD, pNF := s.ModelsDataHooks(); pOD == nil || pNF == nil || !pNF() {
		t.Fatal("public hooks")
	}
	if !needsFull() {
		t.Fatal("needsFull should be true before any catalog sync")
	}
	var inm []string
	body := priceSyncAPI(150)
	ps := usage.NewPriceSync(usage.PriceSyncDeps{
		Root:      filepath.Join(ud, "usage"),
		OnData:    onData,
		NeedsFull: needsFull,
		FetchImpl: func(req *http.Request) (*http.Response, error) {
			inm = append(inm, req.Header.Get("If-None-Match"))
			return &http.Response{StatusCode: 200, Header: http.Header{"Etag": {`"v1"`}}, Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
		},
	})
	t.Cleanup(ps.WaitWrites)
	if r := ps.Sync(); !r.OK {
		t.Fatalf("first sync: %+v", r)
	}
	if !s.HasCatalogSync() || needsFull() {
		t.Fatal("gateway catalog overlay not applied by PriceSync onData")
	}
	if n := models.CatalogSize(); n < 150 {
		t.Fatalf("catalog size %d", n)
	}
	ps.Sync()
	if len(inm) != 2 || inm[0] != "" || inm[1] != `"v1"` {
		t.Fatalf("If-None-Match sequence %q", inm)
	}
	// catalog lost → force full download again
	models.SetCatalogOverlay(nil)
	ps.Sync()
	if !s.HasCatalogSync() {
		t.Fatal("full re-download did not restore the catalog")
	}
	if len(inm) != 3 || inm[2] != "" {
		t.Fatalf("needsFull not honoured: %q", inm)
	}
	var nilSvc *Service
	od, nf := nilSvc.ModelsDataHooks()
	if od(nil) != nil || nf() {
		t.Fatal("nil gateway hooks must be no-op/false")
	}
	// applyModelsData(null) only warns (too few models) and keeps the catalog
	if err := onData(nil); err != nil || !s.HasCatalogSync() {
		t.Fatalf("apply(nil): err=%v synced=%v", err, s.HasCatalogSync())
	}
}
