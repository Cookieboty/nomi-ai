package extensions

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

type OAuthFlowError struct{ Reason string }

func (e *OAuthFlowError) Error() string { return "MCP OAuth: " + e.Reason }

type OAuthRequiredError struct{}

func (*OAuthRequiredError) Error() string { return "MCP OAuth authorization required" }

type oauthDiscovery struct {
	Resource              string `json:"resource"`
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorizationEndpoint"`
	TokenEndpoint         string `json:"tokenEndpoint"`
	RegistrationEndpoint  string `json:"registrationEndpoint,omitempty"`
	Scope                 string `json:"scope,omitempty"`
	RequireIssuer         bool   `json:"requireIssuer"`
}
type oauthCredentials struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken,omitempty"`
	ExpiresAt    int64  `json:"expiresAt,omitempty"`
}
type oauthStored struct {
	Version            int               `json:"version"`
	Server             string            `json:"server"`
	ConfiguredClientID string            `json:"configuredClientId,omitempty"`
	Discovery          *oauthDiscovery   `json:"discovery,omitempty"`
	ClientID           string            `json:"clientId,omitempty"`
	RedirectURI        string            `json:"redirectUri,omitempty"`
	Tokens             *oauthCredentials `json:"tokens,omitempty"`
}
type oauthSession struct {
	mu                     sync.Mutex
	refreshMu              sync.Mutex
	ctx                    context.Context
	cancel                 context.CancelFunc
	file, server, clientID string
	box                    security.SecretBox
	open                   func(string) error
	onRequired             func()
	stored                 oauthStored
	required               bool
	metadataURL, scope     string
	client                 *http.Client
}

func canonicalOAuth(raw string) string { return strings.TrimSuffix(raw, "/") }
func newOAuthSession(root, id, server, clientID string, box security.SecretBox, open func(string) error, onRequired func()) *oauthSession {
	ctx, cancel := context.WithCancel(context.Background())
	s := &oauthSession{ctx: ctx, cancel: cancel, file: oauthFile(root, id), server: server, clientID: clientID, box: box, open: open, onRequired: onRequired}
	s.stored = oauthStored{Version: 1, Server: canonicalOAuth(server), ConfiguredClientID: clientID}
	if b, e := os.ReadFile(s.file); e == nil && strings.HasPrefix(string(b), "enc:") {
		var v oauthStored
		if json.Unmarshal([]byte(box.Decrypt(string(b))), &v) == nil && v.Version == 1 && v.Server == s.stored.Server && v.ConfiguredClientID == clientID {
			s.stored = v
		}
	}
	s.client = newOAuthMCPClient()
	return s
}

// Keep ordinary MCP traffic on the same direct, uncompressed HTTP transport as the
// native MCP client. OAuth only adds credentials; it must not opt into ambient proxies.
func newOAuthMCPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:              nil,
			DisableCompression: true,
			ForceAttemptHTTP2:  false,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("MCP redirect blocked") },
	}
}
func (s *oauthSession) snapshot() oauthStored { s.mu.Lock(); defer s.mu.Unlock(); return s.stored }
func (s *oauthSession) HasCredentials() bool {
	v := s.snapshot()
	return v.Tokens != nil && v.Tokens.AccessToken != ""
}
func (s *oauthSession) Required() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.required }
func (s *oauthSession) Clear() error {
	s.cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	err := os.Remove(s.file)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
func (s *oauthSession) saveLocked(v oauthStored) error {
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	enc, err := s.box.Encrypt(string(b), "OAuth secure storage unavailable")
	if err != nil {
		return &OAuthFlowError{"storage"}
	}
	if err = os.MkdirAll(filepath.Dir(s.file), 0o700); err != nil {
		return err
	}
	if err = utils.WritePrivateFileAtomic(s.file, []byte(enc)); err != nil {
		return err
	}
	s.stored = v
	return nil
}

func (s *oauthSession) save(v oauthStored) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(v)
}

// Credential invalidation must be durable before the UI is told to authorize again.
// If secure persistence fails, deleting the old file is a safe representation of an
// unauthenticated session and prevents rejected credentials from returning on restart.
func (s *oauthSession) persistInvalidationLocked(v oauthStored) error {
	if err := s.saveLocked(v); err == nil {
		return nil
	}
	if err := os.Remove(s.file); err != nil && !os.IsNotExist(err) {
		return &OAuthFlowError{"storage"}
	}
	s.stored = v
	return nil
}

var errOAuthSuperseded = errors.New("OAuth credentials superseded")

func oauthTokenValue(tokens *oauthCredentials) (string, string) {
	if tokens == nil {
		return "", ""
	}
	return tokens.AccessToken, tokens.RefreshToken
}

func sameOAuthCredentials(a, b oauthStored) bool {
	aa, ar := oauthTokenValue(a.Tokens)
	ba, br := oauthTokenValue(b.Tokens)
	return a.ClientID == b.ClientID && aa == ba && ar == br
}

// Only the credentials that produced a rejected response may be invalidated.
// A late 401 or token error from an older request must not clear a newer login.
func (s *oauthSession) requireAuthorizationFor(expected oauthStored, resetDynamicClient bool, discovery *oauthDiscovery) (bool, error) {
	s.mu.Lock()
	if s.ctx.Err() != nil {
		err := s.ctx.Err()
		s.mu.Unlock()
		return false, err
	}
	if !sameOAuthCredentials(s.stored, expected) {
		s.mu.Unlock()
		return false, nil
	}
	v := s.stored
	if discovery != nil {
		v.Discovery = discovery
	}
	v.Tokens = nil
	// A configured client ID belongs to the user and must be preserved. A dynamically
	// registered ID rejected as invalid_client must be discarded so the next attempt
	// registers a fresh native client instead of looping on the rejected ID.
	if resetDynamicClient && s.clientID == "" {
		v.ClientID = ""
		v.RedirectURI = ""
	}
	if err := s.persistInvalidationLocked(v); err != nil {
		s.mu.Unlock()
		return false, err
	}
	s.required = true
	s.mu.Unlock()
	if s.onRequired != nil {
		go s.onRequired()
	}
	return true, nil
}

func (s *oauthSession) requireAuthorization() error {
	v := s.snapshot()
	_, err := s.requireAuthorizationFor(v, false, nil)
	return err
}

func (s *oauthSession) requireAuthorizationWithClientReset(resetDynamicClient bool) error {
	v := s.snapshot()
	_, err := s.requireAuthorizationFor(v, resetDynamicClient, nil)
	return err
}

var resourceMetadataRe = regexp.MustCompile(`(?i)\bresource_metadata\s*=\s*"([^"]+)"`)
var oauthScopeRe = regexp.MustCompile(`(?i)\bscope\s*=\s*"([^"]+)"`)
var oauthBearerRe = regexp.MustCompile(`(?i)\bBearer\b`)

// Fetch is per-transport, not a global interceptor. Never send a token to an SSE-provided foreign origin.
func (s *oauthSession) Fetch(req *http.Request) (response *http.Response, fetchErr error) {
	if s.ctx.Err() != nil {
		return nil, s.ctx.Err()
	}
	selected, _ := url.Parse(s.server)
	if selected == nil || req.URL.Scheme != selected.Scheme || req.URL.Host != selected.Host || req.URL.User != nil {
		return nil, &OAuthFlowError{"failed"}
	}
	ctx, cancel := context.WithCancel(req.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	defer func() {
		if fetchErr != nil {
			stop()
			cancel()
		} else if response != nil {
			response.Body = &oauthBody{ReadCloser: response.Body, cleanup: func() { stop(); cancel() }}
		}
	}()
	run := func(v oauthStored) (*http.Response, error) {
		r := req.Clone(ctx)
		r.Header = req.Header.Clone()
		if req.GetBody != nil {
			b, e := req.GetBody()
			if e != nil {
				return nil, e
			}
			r.Body = b
		}
		if v.Tokens != nil {
			r.Header.Set("Authorization", "Bearer "+v.Tokens.AccessToken)
		}
		return s.client.Do(r)
	}
	v := s.snapshot()
	if v.Tokens != nil && v.Tokens.ExpiresAt > 0 && v.Tokens.ExpiresAt <= time.Now().UnixMilli()+30_000 {
		if e := s.refreshTokens(); e != nil {
			return nil, e
		}
		v = s.snapshot()
	}
	refreshed := false
	for attempt := 0; ; attempt++ {
		res, err := run(v)
		if err != nil {
			return nil, err
		}
		challenge := res.Header.Get("WWW-Authenticate")
		authFailed := res.StatusCode == 401 || (res.StatusCode == 403 && oauthBearerRe.MatchString(challenge) && strings.Contains(strings.ToLower(challenge), "insufficient_scope"))
		if !authFailed {
			return res, nil
		}
		current := s.snapshot()
		if !sameOAuthCredentials(v, current) {
			if attempt >= 2 {
				return res, nil
			}
			res.Body.Close()
			v = current
			continue
		}
		if res.StatusCode == 401 && !refreshed && v.Tokens != nil && v.Tokens.RefreshToken != "" {
			res.Body.Close()
			if err = s.refreshTokens(); err != nil {
				return nil, err
			}
			refreshed = true
			v = s.snapshot()
			continue
		}
		s.mu.Lock()
		if !sameOAuthCredentials(s.stored, v) {
			s.mu.Unlock()
			if attempt >= 2 {
				return res, nil
			}
			res.Body.Close()
			v = s.snapshot()
			continue
		}
		s.metadataURL = ""
		s.scope = ""
		if m := resourceMetadataRe.FindStringSubmatch(challenge); len(m) > 1 {
			s.metadataURL = m[1]
		}
		if m := oauthScopeRe.FindStringSubmatch(challenge); len(m) > 1 {
			s.scope = m[1]
		}
		known := s.stored.Discovery != nil
		s.mu.Unlock()
		var applied bool
		if known {
			applied, err = s.requireAuthorizationFor(v, false, nil)
		} else {
			d, discoverErr := s.discover()
			if discoverErr != nil {
				return res, nil
			}
			applied, err = s.requireAuthorizationFor(v, false, d)
		}
		if err != nil {
			res.Body.Close()
			return nil, err
		}
		if !applied && attempt < 2 {
			res.Body.Close()
			v = s.snapshot()
			continue
		}
		return res, nil
	}
}

type oauthBody struct {
	io.ReadCloser
	cleanup func()
	once    sync.Once
}

func (b *oauthBody) Close() error { err := b.ReadCloser.Close(); b.once.Do(b.cleanup); return err }
func strOAuth(v any) string       { s, _ := v.(string); return s }
func strsOAuth(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, x := range list {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func includesOAuth(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
func (s *oauthSession) discover() (*oauthDiscovery, error) {
	server, _ := url.Parse(s.server)
	if server == nil {
		return nil, &OAuthFlowError{"discovery"}
	}
	s.mu.Lock()
	hint, scope := s.metadataURL, s.scope
	s.mu.Unlock()
	origin := server.Scheme + "://" + server.Host
	candidates := []string{origin + "/.well-known/oauth-protected-resource" + strings.TrimSuffix(server.Path, "/"), origin + "/.well-known/oauth-protected-resource"}
	if hint != "" {
		candidates = []string{hint}
	}
	get := func(urls []string) map[string]any {
		for _, raw := range urls {
			status, data, err := oauthRequest(s.ctx, s.server, raw, "GET", "", "")
			if err == nil && status == 200 {
				return data
			}
			if s.ctx.Err() != nil {
				return nil
			}
		}
		return nil
	}
	resource := get(candidates)
	resourceURL := strOAuth(resource["resource"])
	issuers := strsOAuth(resource["authorization_servers"])
	if resourceURL == "" || canonicalOAuth(resourceURL) != canonicalOAuth(s.server) || len(issuers) == 0 {
		return nil, &OAuthFlowError{"discovery"}
	}
	issuer := issuers[0]
	as, err := oauthEndpoint(issuer, s.server)
	if err != nil || as.RawQuery != "" {
		return nil, &OAuthFlowError{"discovery"}
	}
	suffix := strings.TrimSuffix(as.Path, "/")
	origin = as.Scheme + "://" + as.Host
	metadata := get([]string{origin + "/.well-known/oauth-authorization-server" + suffix, origin + "/.well-known/openid-configuration" + suffix, origin + suffix + "/.well-known/openid-configuration"})
	if metadata == nil || strOAuth(metadata["issuer"]) != issuer || !includesOAuth(strsOAuth(metadata["code_challenge_methods_supported"]), "S256") {
		return nil, &OAuthFlowError{"discovery"}
	}
	d := &oauthDiscovery{Resource: resourceURL, Issuer: issuer, AuthorizationEndpoint: strOAuth(metadata["authorization_endpoint"]), TokenEndpoint: strOAuth(metadata["token_endpoint"]), RegistrationEndpoint: strOAuth(metadata["registration_endpoint"]), Scope: scope, RequireIssuer: metadata["authorization_response_iss_parameter_supported"] == true}
	if d.Scope == "" {
		d.Scope = strings.Join(strsOAuth(resource["scopes_supported"]), " ")
	}
	for _, raw := range []string{d.AuthorizationEndpoint, d.TokenEndpoint} {
		if _, err := oauthEndpoint(raw, s.server); err != nil {
			return nil, &OAuthFlowError{"discovery"}
		}
	}
	if d.RegistrationEndpoint != "" {
		if _, err := oauthEndpoint(d.RegistrationEndpoint, s.server); err != nil {
			return nil, &OAuthFlowError{"discovery"}
		}
	}
	return d, nil
}
func (s *oauthSession) tokenRequest(v oauthStored, params url.Values) (*oauthCredentials, error) {
	if v.Discovery == nil || v.ClientID == "" {
		return nil, &OAuthRequiredError{}
	}
	params.Set("client_id", v.ClientID)
	params.Set("resource", v.Discovery.Resource)
	status, data, err := oauthRequest(s.ctx, s.server, v.Discovery.TokenEndpoint, "POST", params.Encode(), "application/x-www-form-urlencoded")
	if err != nil {
		return nil, err
	}
	if status != 200 {
		switch strOAuth(data["error"]) {
		case "invalid_client":
			applied, err := s.requireAuthorizationFor(v, true, nil)
			if err != nil {
				return nil, err
			}
			if !applied {
				return nil, errOAuthSuperseded
			}
			return nil, &OAuthRequiredError{}
		case "invalid_grant", "invalid_token":
			applied, err := s.requireAuthorizationFor(v, false, nil)
			if err != nil {
				return nil, err
			}
			if !applied {
				return nil, errOAuthSuperseded
			}
			return nil, &OAuthRequiredError{}
		}
		return nil, &OAuthFlowError{"failed"}
	}
	access := strOAuth(data["access_token"])
	if access == "" || strings.ContainsAny(access, "\r\n") || !strings.EqualFold(strOAuth(data["token_type"]), "bearer") {
		return nil, &OAuthFlowError{"failed"}
	}
	t := &oauthCredentials{AccessToken: access, RefreshToken: strOAuth(data["refresh_token"])}
	if t.RefreshToken == "" && v.Tokens != nil {
		t.RefreshToken = v.Tokens.RefreshToken
	}
	if expires, has := data["expires_in"]; has {
		seconds, ok := expires.(float64)
		if !ok || seconds <= 0 || seconds > 1e12 {
			return nil, &OAuthFlowError{"failed"}
		}
		t.ExpiresAt = time.Now().UnixMilli() + int64(seconds*1000)
	}
	return t, nil
}
func (s *oauthSession) refreshTokens() error {
	before := s.snapshot()
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	v := s.snapshot()
	if before.Tokens != nil && v.Tokens != nil && before.Tokens.AccessToken != v.Tokens.AccessToken {
		return nil
	}
	if v.Tokens == nil || v.Tokens.RefreshToken == "" {
		applied, err := s.requireAuthorizationFor(v, false, nil)
		if err != nil {
			return err
		}
		if !applied {
			return nil
		}
		return &OAuthRequiredError{}
	}
	t, err := s.tokenRequest(v, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {v.Tokens.RefreshToken}})
	if errors.Is(err, errOAuthSuperseded) {
		return nil
	}
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !sameOAuthCredentials(s.stored, v) {
		return nil
	}
	next := s.stored
	next.Tokens = t
	return s.saveLocked(next)
}
func randomOAuth() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func (s *oauthSession) Authorize() error {
	if _, err := oauthEndpoint(s.server, s.server); err != nil {
		return &OAuthFlowError{"discovery"}
	}
	if !s.box.CanEncrypt() {
		return &OAuthFlowError{"storage"}
	}
	d, err := s.discover()
	if err != nil {
		return err
	}
	v := s.snapshot()
	if v.Discovery != nil && v.Discovery.Issuer != d.Issuer {
		v.ClientID = ""
		v.Tokens = nil
	}
	v.Discovery = d
	state, err := randomOAuth()
	if err != nil {
		return err
	}
	verifier, err := randomOAuth()
	if err != nil {
		return err
	}
	cb, err := s.callback(state, d, v.RedirectURI)
	if err != nil {
		return err
	}
	defer cb.close()
	clientID := s.clientID
	if clientID == "" && v.RedirectURI == cb.redirectURI {
		clientID = v.ClientID
	}
	if clientID == "" {
		if d.RegistrationEndpoint == "" {
			return &OAuthFlowError{"client"}
		}
		b, _ := json.Marshal(map[string]any{"client_name": "Nomi", "application_type": "native", "redirect_uris": []string{cb.redirectURI}, "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}, "token_endpoint_auth_method": "none"})
		status, data, err := oauthRequest(s.ctx, s.server, d.RegistrationEndpoint, "POST", string(b), "application/json")
		if err != nil {
			return err
		}
		clientID = strOAuth(data["client_id"])
		if (status != 200 && status != 201) || clientID == "" || (strOAuth(data["token_endpoint_auth_method"]) != "" && data["token_endpoint_auth_method"] != "none") {
			return &OAuthFlowError{"client"}
		}
		if redirects, ok := data["redirect_uris"]; ok && !includesOAuth(strsOAuth(redirects), cb.redirectURI) {
			return &OAuthFlowError{"client"}
		}
	}
	v.ClientID = clientID
	v.RedirectURI = cb.redirectURI
	if err = s.save(v); err != nil {
		return err
	}
	auth, _ := url.Parse(d.AuthorizationEndpoint)
	p := auth.Query()
	hash := sha256.Sum256([]byte(verifier))
	for k, val := range map[string]string{"response_type": "code", "client_id": clientID, "redirect_uri": cb.redirectURI, "state": state, "code_challenge": base64.RawURLEncoding.EncodeToString(hash[:]), "code_challenge_method": "S256", "resource": d.Resource} {
		p.Set(k, val)
	}
	if d.Scope != "" {
		p.Set("scope", d.Scope)
	}
	auth.RawQuery = p.Encode()
	if s.open == nil {
		return &OAuthFlowError{"failed"}
	}
	if err = s.open(auth.String()); err != nil {
		return err
	}
	var code string
	select {
	case result := <-cb.result:
		if result.err != nil {
			return result.err
		}
		code = result.code
	case <-s.ctx.Done():
		return s.ctx.Err()
	case <-time.After(180 * time.Second):
		return &OAuthFlowError{"timeout"}
	}
	tokens, err := s.tokenRequest(v, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {cb.redirectURI}})
	if errors.Is(err, errOAuthSuperseded) {
		return nil
	}
	if err != nil {
		return err
	}
	v.Tokens = tokens
	if err = s.save(v); err != nil {
		return err
	}
	s.mu.Lock()
	s.required = false
	s.mu.Unlock()
	return nil
}

type oauthCallbackResult struct {
	code string
	err  error
}
type oauthCallback struct {
	redirectURI string
	result      chan oauthCallbackResult
	close       func()
}

func (s *oauthSession) callback(state string, d *oauthDiscovery, previous string) (*oauthCallback, error) {
	port := "0"
	if u, err := url.Parse(previous); err == nil && u.Port() != "" {
		port = u.Port()
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:"+port)
	if err != nil {
		listener, err = net.Listen("tcp4", "127.0.0.1:0")
	}
	if err != nil {
		return nil, err
	}
	host := listener.Addr().String()
	cb := &oauthCallback{redirectURI: "http://" + host + "/mcp/oauth/callback", result: make(chan oauthCallbackResult, 1)}
	consumed := false
	var mu sync.Mutex
	srv := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		p := r.URL.Query()
		mu.Lock()
		defer mu.Unlock()
		valid := r.Method == "GET" && r.Host == host && r.URL.Path == "/mcp/oauth/callback" && !consumed && subtle.ConstantTimeCompare([]byte(state), []byte(p.Get("state"))) == 1
		for _, k := range []string{"state", "code", "error", "iss"} {
			if len(p[k]) > 1 {
				valid = false
			}
		}
		if (p.Has("iss") && p.Get("iss") != d.Issuer) || (d.RequireIssuer && !p.Has("iss")) {
			valid = false
		}
		code, oauthErr := p.Get("code"), p.Get("error")
		if (code == "" && oauthErr == "") || (code != "" && oauthErr != "") {
			valid = false
		}
		if !valid {
			http.Error(w, "Invalid authorization callback.", 400)
			return
		}
		consumed = true
		if oauthErr != "" {
			fmt.Fprint(w, T("ui.foundation.mcp-oauth-callback-denied"))
			cb.result <- oauthCallbackResult{err: &OAuthFlowError{"denied"}}
		} else {
			fmt.Fprint(w, T("ui.foundation.mcp-oauth-callback-received"))
			cb.result <- oauthCallbackResult{code: code}
		}
	})}
	cb.close = func() { _ = srv.Close() }
	go func() { _ = srv.Serve(listener) }()
	return cb, nil
}
