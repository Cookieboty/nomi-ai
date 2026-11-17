package shell

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAcceptPageMessageDropsBrowserWindows(t *testing.T) {
	for _, tc := range []struct {
		name string
		main bool
		want bool
	}{
		{"chat", true, true},
		{"mascot", true, true},
		{"chat", false, false},                // 内嵌 iframe
		{"browser-0123456789ab", true, false}, // 外部网页的主框架也不收
		{"browser-0123456789ab", false, false},
	} {
		if got := AcceptPageMessage(tc.name, tc.main); got != tc.want {
			t.Errorf("AcceptPageMessage(%q, %v) = %v, want %v", tc.name, tc.main, got, tc.want)
		}
	}
}

func TestGuardBrowserWindowAssetsBlocksRuntimeAndPages(t *testing.T) {
	reached := 0
	h := GuardBrowserWindowAssets(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.WriteHeader(http.StatusOK)
	}))
	for _, path := range []string{"/wails/runtime", "/wails/runtime.js", "/chat/index.html"} {
		req := httptest.NewRequest(http.MethodPost, "http://wails.localhost"+path, nil)
		req.Header.Set(wailsWindowNameHeader, "browser-0123456789ab")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s from browser window: status %d, want 403", path, rec.Code)
		}
	}
	if reached != 0 {
		t.Fatalf("browser-window requests reached the asset handler %d times", reached)
	}
	for _, name := range []string{"chat", "mascot", ""} {
		req := httptest.NewRequest(http.MethodPost, "http://wails.localhost/wails/runtime", nil)
		if name != "" {
			req.Header.Set(wailsWindowNameHeader, name)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("window %q: status %d, want 200", name, rec.Code)
		}
	}
	if reached != 3 {
		t.Fatalf("app windows reached handler %d times, want 3", reached)
	}
}
