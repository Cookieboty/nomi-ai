package extensions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type mcpOperation struct {
	ctx    context.Context
	cancel context.CancelFunc
}

// Caller holds s.mu. Cancelling a session prevents late callbacks/refreshes from writing credentials.
func (s *Service) invalidate(id string, clear bool) error {
	if op := s.operations[id]; op != nil {
		op.cancel()
		delete(s.operations, id)
	}
	if oauth := s.oauth[id]; oauth != nil {
		oauth.cancel()
		// Wait for a save already past its cancellation check before removing its file.
		oauth.mu.Lock()
		oauth.mu.Unlock()
		delete(s.oauth, id)
	}
	for name := range s.rawTools {
		if strings.HasPrefix(name, id+"__") {
			delete(s.rawTools, name)
		}
	}
	if clear {
		hash := sha256.Sum256([]byte(id))
		err := os.Remove(filepath.Join(s.d.Root, "oauth", hex.EncodeToString(hash[:])+".json"))
		if err != nil && !os.IsNotExist(err) {
			return &McpConfigError{T("ui.foundation.mcp-authorization-remove-failed")}
		}
	}
	return nil
}
func (s *Service) oauthSession(e *McpServerEntry) *oauthSession {
	if e == nil || e.Transport == "stdio" || e.URL == "" {
		return nil
	}
	for k := range e.Headers {
		if strings.EqualFold(k, "Authorization") {
			return nil
		}
	}
	session := s.oauth[e.ID]
	if session == nil {
		id := e.ID
		session = newOAuthSession(s.d.Root, id, e.URL, e.OAuthClientID, s.d.Secrets, s.d.OpenExternal, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.oauth[id] != session || !session.Required() || s.live[id].Auth == "pending" {
				return
			}
			connected := s.live[id].Status == "connected"
			s.live[id] = Live{Status: "authorization-required", Auth: "required", Tools: []LiveTool{}}
			s.changed()
			if connected {
				runtime := s.runtime()
				closing := make(chan struct{})
				s.closing[id] = closing
				go func() {
					if runtime != nil {
						_ = runtime.Disconnect(context.Background(), id)
					}
					close(closing)
				}()
			}
		})
		s.oauth[id] = session
	}
	return session
}
func (s *Service) Authorize(id string) (Live, error) {
	s.mu.Lock()
	e := s.find(id)
	if e == nil {
		s.mu.Unlock()
		return Live{}, &McpConfigError{T("electron.common.server-not-found")}
	}
	if s.operations[id] != nil {
		live := s.live[id]
		s.mu.Unlock()
		return live, nil
	}
	oauth := s.oauthSession(e)
	if oauth == nil {
		s.mu.Unlock()
		return Live{}, &McpConfigError{T("ui.foundation.mcp-oauth-unavailable")}
	}
	ctx, cancel := context.WithCancel(context.Background())
	op := &mcpOperation{ctx: ctx, cancel: cancel}
	s.operations[id] = op
	live := Live{Status: "authorization-required", Auth: "pending", Tools: []LiveTool{}}
	s.live[id] = live
	s.changed()
	s.mu.Unlock()
	go func() { s.finishAuthorization(id, op, oauth.Authorize()) }()

	return live, nil
}

// finishAuthorization keeps the original operation alive through automatic reconnect.
// The connection entry point, not a prior unlocked check, owns the generation guard.
func (s *Service) finishAuthorization(id string, op *mcpOperation, err error) {
	if err == nil {
		_, err = s.connectOperation(op.ctx, id, op)
		if err == nil {
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if op.ctx.Err() != nil || s.operations[id] != op {
		return
	}
	delete(s.operations, id)
	op.cancel()
	reason := "failed"
	var flow *OAuthFlowError
	if errors.As(err, &flow) {
		reason = flow.Reason
	}
	s.live[id] = Live{Status: "authorization-required", Auth: "required", Tools: []LiveTool{}, Error: oauthMessage(reason)}
	s.changed()
}

func (s *Service) ClearAuthorization(ctx context.Context, id string) (bool, error) {
	s.mu.Lock()
	e := s.find(id)
	if e == nil {
		s.mu.Unlock()
		return false, nil
	}
	oauth := s.oauthSession(e)
	var clearErr error
	if oauth != nil {
		clearErr = oauth.Clear()
	}
	s.mu.Unlock()
	// Clear cancels the session before touching disk. Even when removing the file
	// fails, retire the cancelled runtime so the UI cannot keep showing a dead
	// connection as connected. A later retry creates a fresh session from disk.
	s.Disconnect(ctx, id)
	if clearErr != nil {
		return false, clearErr
	}
	return true, nil
}
func (s *Service) Dispose() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.oauth {
		s.invalidate(id, false)
	}
}
func oauthMessage(reason string) string {
	keys := map[string]string{"discovery": "ui.foundation.mcp-oauth-discovery", "client": "ui.foundation.mcp-oauth-client", "denied": "ui.foundation.mcp-oauth-denied", "timeout": "ui.foundation.mcp-oauth-timeout", "storage": "ui.foundation.mcp-oauth-storage", "failed": "ui.foundation.mcp-oauth-failed"}
	key, ok := keys[reason]
	if !ok {
		key = keys["failed"]
	}
	return T(key)
}
