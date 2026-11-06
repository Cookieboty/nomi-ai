package extensions

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

type oauthFixture struct {
	server                     *httptest.Server
	mu                         sync.Mutex
	token, rejected, challenge string
	refreshes                  int
	registrations              int
	invalidGrant               bool
	invalidClient              bool
	registered                 map[string]any
}

func (f *oauthFixture) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	reply := func(status int, v any) { w.WriteHeader(status); _ = json.NewEncoder(w).Encode(v) }
	origin := f.server.URL
	switch r.URL.Path {
	case "/mcp":
		if r.Header.Get("Authorization") == "Bearer "+f.token && f.token != f.rejected {
			reply(200, map[string]any{"ok": true})
		} else {
			w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+origin+`/.well-known/oauth-protected-resource/mcp", scope="tools.read"`)
			reply(401, map[string]any{})
		}
	case "/.well-known/oauth-protected-resource/mcp":
		reply(200, map[string]any{"resource": origin + "/mcp", "authorization_servers": []string{origin}, "scopes_supported": []string{"tools.read"}})
	case "/.well-known/oauth-authorization-server":
		reply(200, map[string]any{"issuer": origin, "authorization_endpoint": origin + "/authorize", "token_endpoint": origin + "/token", "registration_endpoint": origin + "/register", "code_challenge_methods_supported": []string{"S256"}, "authorization_response_iss_parameter_supported": true})
	case "/register":
		f.registrations++
		_ = json.NewDecoder(r.Body).Decode(&f.registered)
		reply(201, map[string]any{"client_id": "native-public-client", "token_endpoint_auth_method": "none", "redirect_uris": f.registered["redirect_uris"]})
	case "/token":
		_ = r.ParseForm()
		p := r.Form
		if f.invalidClient {
			reply(400, map[string]any{"error": "invalid_client"})
			return
		}
		if p.Get("resource") != origin+"/mcp" || p.Get("client_id") != "native-public-client" {
			reply(400, map[string]any{"error": "invalid_request"})
			return
		}
		if p.Get("grant_type") == "refresh_token" {
			f.refreshes++
			if f.invalidGrant {
				reply(400, map[string]any{"error": "invalid_grant"})
				return
			}
			f.token = "refreshed-token"
			reply(200, map[string]any{"access_token": f.token, "token_type": "Bearer", "expires_in": 3600})
			return
		}
		hash := sha256.Sum256([]byte(p.Get("code_verifier")))
		if base64.RawURLEncoding.EncodeToString(hash[:]) != f.challenge || p.Get("code") != "one-time-code" {
			reply(400, map[string]any{"error": "invalid_grant"})
			return
		}
		reply(200, map[string]any{"access_token": f.token, "refresh_token": "refresh-secret", "token_type": "Bearer", "expires_in": 3600})
	default:
		reply(404, map[string]any{})
	}
}
func newOAuthFixture(t *testing.T) *oauthFixture {
	t.Helper()
	f := &oauthFixture{token: "initial-secret-token"}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}
func (f *oauthFixture) open(t *testing.T) func(string) error {
	return func(raw string) error {
		auth, _ := url.Parse(raw)
		f.mu.Lock()
		f.challenge = auth.Query().Get("code_challenge")
		f.mu.Unlock()
		if auth.Query().Get("code_challenge_method") != "S256" || auth.Query().Get("resource") != f.server.URL+"/mcp" {
			t.Error("missing PKCE or resource")
		}
		cb, _ := url.Parse(auth.Query().Get("redirect_uri"))
		p := url.Values{"state": {auth.Query().Get("state")}, "code": {"one-time-code"}, "iss": {f.server.URL}}
		cb.RawQuery = p.Encode()
		res, err := http.Get(cb.String())
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Errorf("callback status %d", res.StatusCode)
		}
		return nil
	}
}
func fetchOAuth(t *testing.T, s *oauthSession) (int, error) {
	t.Helper()
	req, _ := http.NewRequest("GET", s.server, nil)
	res, err := s.Fetch(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	_, err = io.ReadAll(res.Body)
	return res.StatusCode, err
}
func TestNativeOAuthEncryptedRestartAndRefresh(t *testing.T) {
	f := newOAuthFixture(t)
	root := t.TempDir()
	box := security.NewMemoryBox()
	s := newOAuthSession(root, "remote", f.server.URL+"/mcp", "", box, f.open(t), nil)
	defer s.cancel()
	if status, err := fetchOAuth(t, s); err != nil || status != 401 || !s.Required() {
		t.Fatal(status, err)
	}
	if err := s.Authorize(); err != nil {
		t.Fatal(err)
	}
	if status, err := fetchOAuth(t, s); err != nil || status != 200 {
		t.Fatal(status, err)
	}
	b, err := os.ReadFile(s.file)
	if err != nil || !strings.HasPrefix(string(b), "enc:") || strings.Contains(string(b), f.token) {
		t.Fatal("credentials not encrypted", err)
	}
	// Windows has no POSIX mode bits; private files rely on the user-data directory permissions there.
	st, _ := os.Stat(s.file)
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatal("credential file permissions", st.Mode())
	}
	s.cancel()
	restored := newOAuthSession(root, "remote", f.server.URL+"/mcp", "", box, nil, nil)
	defer restored.cancel()
	if !restored.HasCredentials() {
		t.Fatal("credentials not restored")
	}
	f.mu.Lock()
	f.rejected = f.token
	f.mu.Unlock()
	if status, err := fetchOAuth(t, restored); err != nil || status != 200 {
		t.Fatal(status, err)
	}
	f.mu.Lock()
	refreshes := f.refreshes
	f.invalidGrant = true
	f.rejected = f.token
	f.mu.Unlock()
	if refreshes != 1 {
		t.Fatal(refreshes)
	}
	if _, err := fetchOAuth(t, restored); err == nil || !restored.Required() || restored.HasCredentials() {
		t.Fatal("invalid grant did not require authorization", err)
	}
	if err := restored.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.file); !os.IsNotExist(err) {
		t.Fatal("authorization file not removed")
	}
}
func TestOAuthCallbackValidationAndCancellation(t *testing.T) {
	f := newOAuthFixture(t)
	s := newOAuthSession(t.TempDir(), "remote", f.server.URL+"/mcp", "", security.NewMemoryBox(), nil, nil)
	defer s.cancel()
	s.open = func(raw string) error {
		auth, _ := url.Parse(raw)
		f.mu.Lock()
		f.challenge = auth.Query().Get("code_challenge")
		f.mu.Unlock()
		cb, _ := url.Parse(auth.Query().Get("redirect_uri"))
		p := url.Values{"state": {"wrong"}, "code": {"one-time-code"}, "iss": {f.server.URL}}
		check := func(status int) {
			cb.RawQuery = p.Encode()
			res, err := http.Get(cb.String())
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != status {
				t.Fatalf("callback %d want %d", res.StatusCode, status)
			}
		}
		check(400)
		p.Set("state", auth.Query().Get("state"))
		p.Set("iss", "https://attacker.example")
		check(400)
		p.Set("iss", f.server.URL)
		p.Add("code", "duplicate")
		check(400)
		p.Set("code", "one-time-code")
		check(200)
		return nil
	}
	if err := s.Authorize(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	cancelled := newOAuthSession(t.TempDir(), "remote", f.server.URL+"/mcp", "", security.NewMemoryBox(), func(string) error { close(ready); return nil }, nil)
	done := make(chan error, 1)
	go func() { done <- cancelled.Authorize() }()
	<-ready
	cancelled.cancel()
	if err := <-done; err != context.Canceled {
		t.Fatal(err)
	}
	if cancelled.HasCredentials() {
		t.Fatal("cancel saved tokens")
	}
}
func TestOAuthEndpointPolicyAndConfigurationBinding(t *testing.T) {
	for _, raw := range []string{"http://example.com/token", "https://127.0.0.1/token", "https://192.168.1.2/token", "https://user:secret@example.com/token", "file:///tmp/token"} {
		if _, err := oauthEndpoint(raw, "https://example.com/mcp"); err == nil {
			t.Fatal("accepted unsafe endpoint", raw)
		}
	}
	f := newOAuthFixture(t)
	root := t.TempDir()
	box := security.NewMemoryBox()
	s := newOAuthSession(root, "remote", f.server.URL+"/mcp", "", box, f.open(t), nil)
	defer s.cancel()
	if err := s.Authorize(); err != nil {
		t.Fatal(err)
	}
	changed := newOAuthSession(root, "remote", f.server.URL+"/other", "", box, nil, nil)
	defer changed.cancel()
	if changed.HasCredentials() {
		t.Fatal("credential resource binding failed")
	}
	client := newOAuthSession(root, "remote", f.server.URL+"/mcp", "another-client", box, nil, nil)
	defer client.cancel()
	if client.HasCredentials() {
		t.Fatal("credential client binding failed")
	}
	if !strings.HasPrefix(s.file, filepath.Join(root, "oauth")) {
		t.Fatal("invalid path")
	}
}

func TestOAuthFetchKeepsMCPTransportPolicy(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("OAuth MCP request reached an ambient proxy")
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	type observedRequest struct{ authorization, encoding, protocol string }
	requests := make(chan observedRequest, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- observedRequest{r.Header.Get("Authorization"), r.Header.Get("Accept-Encoding"), r.Proto}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	session := newOAuthSession(t.TempDir(), "direct", "http://mcp.example.test/mcp", "", security.NewMemoryBox(), nil, nil)
	defer session.cancel()
	tr, ok := session.client.Transport.(*http.Transport)
	if !ok || tr.Proxy != nil || !tr.DisableCompression || tr.ForceAttemptHTTP2 {
		t.Fatalf("OAuth changed the MCP transport policy: %#v", session.client.Transport)
	}
	direct := tr.Clone()
	direct.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "mcp.example.test:80" {
			t.Errorf("unexpected proxy destination: %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	defer direct.CloseIdleConnections()
	session.client.Transport = direct
	session.stored.Tokens = &oauthCredentials{AccessToken: "test-bearer"}
	if status, err := fetchOAuth(t, session); err != nil || status != http.StatusOK {
		t.Fatal(status, err)
	}
	got := <-requests
	if got.authorization != "Bearer test-bearer" || got.encoding != "" || got.protocol != "HTTP/1.1" {
		t.Fatalf("unexpected request: %+v", got)
	}
	session.stored.Tokens = nil
	if status, err := fetchOAuth(t, session); err != nil || status != http.StatusOK {
		t.Fatal(status, err)
	}
	if got := <-requests; got.authorization != "" {
		t.Fatal("sent a token after credentials were removed")
	}
}

func TestOAuthInvalidClientResetsOnlyDynamicRegistration(t *testing.T) {
	f := newOAuthFixture(t)
	seed := func(t *testing.T, configuredClientID string) (*oauthSession, oauthStored) {
		t.Helper()
		s := newOAuthSession(t.TempDir(), "remote", f.server.URL+"/mcp", configuredClientID, security.NewMemoryBox(), f.open(t), nil)
		v := s.snapshot()
		v.Discovery = &oauthDiscovery{
			Resource:      f.server.URL + "/mcp",
			Issuer:        f.server.URL,
			TokenEndpoint: f.server.URL + "/token",
		}
		if configuredClientID == "" {
			v.ClientID = "rejected-dynamic-client"
		} else {
			v.ClientID = configuredClientID
		}
		v.RedirectURI = "http://127.0.0.1:12345/mcp/oauth/callback"
		v.Tokens = &oauthCredentials{AccessToken: "expired", RefreshToken: "refresh-secret"}
		if err := s.save(v); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(s.cancel)
		return s, v
	}

	t.Run("dynamic client is re-registered", func(t *testing.T) {
		s, v := seed(t, "")
		f.mu.Lock()
		f.invalidClient = true
		f.mu.Unlock()
		_, err := s.tokenRequest(v, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {"refresh-secret"}})
		var required *OAuthRequiredError
		if !errors.As(err, &required) {
			t.Fatalf("invalid_client returned %v", err)
		}
		reset := s.snapshot()
		if reset.ClientID != "" || reset.RedirectURI != "" || reset.Tokens != nil || !s.Required() {
			t.Fatalf("dynamic client was not reset: %+v", reset)
		}
		f.mu.Lock()
		f.invalidClient = false
		f.mu.Unlock()
		if err := s.Authorize(); err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		registrations := f.registrations
		f.mu.Unlock()
		if registrations != 1 || !s.HasCredentials() {
			t.Fatalf("dynamic client was not registered again: registrations=%d", registrations)
		}
	})

	t.Run("late invalid_client cannot clear newer credentials", func(t *testing.T) {
		s, v := seed(t, "")
		newer := s.snapshot()
		newer.ClientID = "new-dynamic-client"
		newer.Tokens = &oauthCredentials{AccessToken: "new-token"}
		if err := s.save(newer); err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		f.invalidClient = true
		f.mu.Unlock()
		_, err := s.tokenRequest(v, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {"refresh-secret"}})
		if !errors.Is(err, errOAuthSuperseded) {
			t.Fatalf("late invalid_client returned %v", err)
		}
		got := s.snapshot()
		if got.ClientID != "new-dynamic-client" || got.Tokens == nil || got.Tokens.AccessToken != "new-token" || s.Required() {
			t.Fatalf("late invalid_client cleared newer credentials: %+v", got)
		}
		f.mu.Lock()
		f.invalidClient = false
		f.mu.Unlock()
	})

	t.Run("configured client is preserved", func(t *testing.T) {
		s, v := seed(t, "configured-client")
		f.mu.Lock()
		f.invalidClient = true
		f.mu.Unlock()
		_, err := s.tokenRequest(v, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {"refresh-secret"}})
		var required *OAuthRequiredError
		if !errors.As(err, &required) {
			t.Fatalf("invalid_client returned %v", err)
		}
		reset := s.snapshot()
		if reset.ClientID != "configured-client" || reset.RedirectURI == "" || reset.Tokens != nil || !s.Required() {
			t.Fatalf("configured client was not preserved: %+v", reset)
		}
	})
}

type failingOAuthBox struct {
	security.SecretBox
	fail bool
}

func (b *failingOAuthBox) Encrypt(value, unavailable string) (string, error) {
	if b.fail {
		return "", errors.New("secure storage failed")
	}
	return b.SecretBox.Encrypt(value, unavailable)
}

func TestOAuthAuthorizationInvalidationIsDurable(t *testing.T) {
	seed := func(t *testing.T) (*oauthSession, *failingOAuthBox, oauthStored) {
		t.Helper()
		box := &failingOAuthBox{SecretBox: security.NewMemoryBox()}
		s := newOAuthSession(t.TempDir(), "remote", "https://example.com/mcp", "", box, nil, nil)
		v := s.snapshot()
		v.ClientID = "rejected-dynamic-client"
		v.RedirectURI = "http://127.0.0.1:12345/mcp/oauth/callback"
		v.Tokens = &oauthCredentials{AccessToken: "stale-token", RefreshToken: "stale-refresh"}
		if err := s.save(v); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(s.cancel)
		return s, box, v
	}

	t.Run("removes the stale file when secure persistence fails", func(t *testing.T) {
		s, box, _ := seed(t)
		box.fail = true
		if err := s.requireAuthorizationWithClientReset(true); err != nil {
			t.Fatal(err)
		}
		reset := s.snapshot()
		if reset.ClientID != "" || reset.RedirectURI != "" || reset.Tokens != nil || !s.Required() {
			t.Fatalf("authorization was not reset in memory: %+v", reset)
		}
		if _, err := os.Stat(s.file); !os.IsNotExist(err) {
			t.Fatalf("stale authorization file survived fallback removal: %v", err)
		}
		box.fail = false
		restored := newOAuthSession(filepath.Dir(filepath.Dir(s.file)), "remote", s.server, "", box, nil, nil)
		defer restored.cancel()
		if got := restored.snapshot(); got.ClientID != "" || restored.HasCredentials() {
			t.Fatalf("stale authorization returned after restart: %+v", got)
		}
	})

	t.Run("reports storage failure when neither write nor removal is possible", func(t *testing.T) {
		s, box, before := seed(t)
		if err := os.Remove(s.file); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(s.file, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s.file, "keep"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		box.fail = true
		err := s.requireAuthorizationWithClientReset(true)
		var flow *OAuthFlowError
		if !errors.As(err, &flow) || flow.Reason != "storage" {
			t.Fatalf("expected storage error, got %v", err)
		}
		got := s.snapshot()
		if got.ClientID != before.ClientID || got.Tokens == nil || s.Required() {
			t.Fatalf("failed invalidation changed the active state: %+v", got)
		}
	})
}

func TestOAuthLateUnauthorizedResponseCannotClearNewCredentials(t *testing.T) {
	requests := make(chan string, 2)
	releaseOld := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		requests <- auth
		if auth == "Bearer old-token" {
			<-releaseOld
			w.Header().Set("WWW-Authenticate", `Bearer scope="tools.read"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if auth == "Bearer new-token" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	s := newOAuthSession(t.TempDir(), "remote", server.URL, "client", security.NewMemoryBox(), nil, nil)
	defer s.cancel()
	v := s.snapshot()
	v.ClientID = "client"
	v.Discovery = &oauthDiscovery{Resource: server.URL, Issuer: server.URL}
	v.Tokens = &oauthCredentials{AccessToken: "old-token"}
	if err := s.save(v); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct {
		status int
		err    error
	}, 1)
	go func() {
		status, err := fetchOAuth(t, s)
		done <- struct {
			status int
			err    error
		}{status, err}
	}()
	if got := <-requests; got != "Bearer old-token" {
		t.Fatalf("first request used %q", got)
	}
	newer := s.snapshot()
	newer.Tokens = &oauthCredentials{AccessToken: "new-token"}
	if err := s.save(newer); err != nil {
		t.Fatal(err)
	}
	close(releaseOld)
	result := <-done
	if result.err != nil || result.status != http.StatusOK {
		t.Fatal(result.status, result.err)
	}
	if got := <-requests; got != "Bearer new-token" {
		t.Fatalf("retry used %q", got)
	}
	if got := s.snapshot(); got.Tokens == nil || got.Tokens.AccessToken != "new-token" || s.Required() {
		t.Fatalf("late 401 cleared the newer authorization: %+v required=%v", got, s.Required())
	}
}
