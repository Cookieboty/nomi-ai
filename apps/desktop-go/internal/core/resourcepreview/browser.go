package resourcepreview

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

// External-browser HTML is served on a dedicated loopback origin, never the application origin.
// There are no Wails runtime routes, websocket credentials, host APIs or directory listings here.
func (s *Service) browserURL(token, name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.browser == nil {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return "", err
		}
		s.browser = &http.Server{Handler: http.HandlerFunc(s.serveBrowser), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute}
		s.browserOrigin = "http://" + listener.Addr().String()
		server := s.browser
		go func() { _ = server.Serve(listener) }()
	}
	return s.browserOrigin + "/" + token + "/" + url.PathEscape(name), nil
}
func (s *Service) Shutdown() {
	s.mu.Lock()
	server := s.browser
	s.browser = nil
	s.items = map[string]capability{}
	s.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
}
func (s *Service) serveBrowser(w http.ResponseWriter, r *http.Request) {
	// The external browser may only read assets in this explicit capability, never application routes.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	v, ok := s.items[parts[0]]
	s.mu.Unlock()
	if !ok || v.info == nil || time.Since(v.at) > ttl {
		http.NotFound(w, r)
		return
	}
	path := v.path
	if parts[1] != filepath.Base(v.path) {
		if v.assetsRoot == "" {
			http.NotFound(w, r)
			return
		}
		path = filepath.Join(v.assetsRoot, filepath.FromSlash(parts[1]))
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || s.denyReason(real) != "" {
		http.NotFound(w, r)
		return
	}
	if real != v.path && (v.assetsRoot == "" || !desktop.IsInside(real, v.assetsRoot, platform())) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(real)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > 32<<20 {
		http.NotFound(w, r)
		return
	}
	if real == v.path && !os.SameFile(st, v.info) {
		http.NotFound(w, r)
		return
	}
	if kindOf(real) == "html" {
		w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-same-origin; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http: https: blob:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; connect-src http: https:; media-src http: https: data: blob:; frame-src 'none'; base-uri 'none'; form-action http: https:")
	}
	http.ServeContent(w, r, filepath.Base(real), st.ModTime(), f)
}
func (s *Service) setBrowserAssets(token, root string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.items[token]
	if !ok {
		return fmt.Errorf("capability expired")
	}
	v.assetsRoot = root
	s.items[token] = v
	return nil
}
