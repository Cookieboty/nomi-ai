package resourcepreview

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

// Web uses the pinned-DNS gateway guard; redirects are checked individually and no credentials are sent.
// Media gets a short-lived streaming capability, not a multi-megabyte base64 response.
func (s *Service) Web(raw string) Result {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for redirects := 0; redirects < 5; redirects++ {
		req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
		if err != nil {
			return fail("network")
		}
		resp, err := gwnet.DefaultUpstreamFetch()(req)
		if err != nil {
			return fail("network")
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			target, err := url.Parse(resp.Header.Get("Location"))
			resp.Body.Close()
			if err != nil || target.String() == "" {
				return fail("network")
			}
			raw = req.URL.ResolveReference(target).String()
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fail("network")
		}
		typ := resp.Header.Get("Content-Type")
		kind := "text"
		switch {
		case strings.HasPrefix(typ, "image/"):
			kind = "image"
		case strings.HasPrefix(typ, "video/"):
			kind = "video"
		case strings.HasPrefix(typ, "audio/"):
			kind = "audio"
		case strings.HasPrefix(typ, "application/pdf"):
			kind = "pdf"
		case strings.Contains(typ, "text/html"):
			kind = "website"
		case strings.HasSuffix(strings.ToLower(req.URL.Path), ".md"):
			kind = "markdown"
		}
		if kind == "website" {
			resp.Body.Close()
			return Result{OK: true, Kind: "external", Path: raw}
		}
		if kind == "image" || kind == "video" || kind == "audio" || kind == "pdf" {
			resp.Body.Close()
			token, err := s.grant(raw, nil)
			if err != nil {
				return fail("network")
			}
			return Result{OK: true, Kind: kind, Path: raw, MIME: typ, URL: Prefix + token}
		}
		if err := gwnet.DecodeUndiciResponse("GET", resp); err != nil {
			resp.Body.Close()
			return fail("network")
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, textLimit+1))
		resp.Body.Close()
		if err != nil {
			return fail("network")
		}
		truncated := len(b) > textLimit
		if truncated {
			b = b[:textLimit]
		}
		return Result{OK: true, Kind: kind, Path: raw, MIME: typ, Content: string(b), Truncated: truncated}
	}
	return fail("network")
}
func serveRemote(w http.ResponseWriter, r *http.Request, raw string) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, r.Method, raw, nil)
	if err != nil {
		http.Error(w, "invalid URL", 400)
		return
	}
	for _, h := range []string{"Range", "If-Range"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	resp, err := gwnet.DefaultUpstreamFetch()(req)
	if err != nil {
		http.Error(w, "network error", 502)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 && resp.StatusCode != 416 {
		http.Error(w, "upstream changed", 502)
		return
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	w.WriteHeader(resp.StatusCode)
	if r.Method != "HEAD" {
		_, _ = io.Copy(w, resp.Body)
	}
}
