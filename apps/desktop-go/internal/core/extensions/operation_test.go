package extensions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

// These tests exercise the completion/cancellation boundary only. They do not
// open a browser, make network requests, or read system credentials.
type operationRuntime struct {
	mu          sync.Mutex
	calls       int
	disconnects int
	connect     func(context.Context, McpConnectConfig) error
	disconnect  func(context.Context, string) error
}

func (r *operationRuntime) ListServers() []McpServerInfo { return nil }
func (r *operationRuntime) Disconnect(ctx context.Context, id string) error {
	r.mu.Lock()
	r.disconnects++
	disconnect := r.disconnect
	r.mu.Unlock()
	if disconnect != nil {
		return disconnect(ctx, id)
	}
	return nil
}
func (r *operationRuntime) Connect(ctx context.Context, cfg McpConnectConfig) error {
	r.mu.Lock()
	r.calls++
	connect := r.connect
	r.mu.Unlock()
	if connect != nil {
		return connect(ctx, cfg)
	}
	return nil
}
func (r *operationRuntime) callCount() int { r.mu.Lock(); defer r.mu.Unlock(); return r.calls }
func (r *operationRuntime) disconnectCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.disconnects
}

type operationRegistry struct{}

func (operationRegistry) Get(string) (ToolDef, bool) { return ToolDef{}, false }
func (operationRegistry) Register(ToolDef)           {}
func (operationRegistry) Unregister(string)          {}

func operationService(t *testing.T) (*Service, *operationRuntime) {
	t.Helper()
	root := t.TempDir()
	s := New(Deps{Root: filepath.Join(root, "extensions"), SkillsRoot: filepath.Join(root, "skills")})
	runtime := &operationRuntime{}
	s.Attach(func() McpRuntime { return runtime }, operationRegistry{})
	_, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "name": "Remote", "transport": "stdio", "command": "node"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Dispose)
	return s, runtime
}
func pendingOperation(t *testing.T, s *Service, id string) *mcpOperation {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	op := &mcpOperation{ctx: ctx, cancel: cancel}
	t.Cleanup(cancel)
	s.mu.Lock()
	s.operations[id] = op
	s.live[id] = Live{Status: "authorization-required", Auth: "pending", Tools: []LiveTool{}}
	s.mu.Unlock()
	return op
}
func waitOperation[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("operation did not settle")
		var zero T
		return zero
	}
}

func TestConnectedServerConfigurationUpdateReconnectsAfterDisconnect(t *testing.T) {
	root := t.TempDir()
	s := New(Deps{Root: filepath.Join(root, "extensions"), SkillsRoot: filepath.Join(root, "skills")})
	runtime := &operationRuntime{}
	s.Attach(func() McpRuntime { return runtime }, operationRegistry{})
	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "name": "Remote", "transport": "http", "url": "https://old.example.com/mcp"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Dispose)
	s.mu.Lock()
	s.live["remote"] = Live{Status: "connected", Tools: []LiveTool{}}
	s.mu.Unlock()

	disconnectEntered := make(chan struct{})
	releaseDisconnect := make(chan struct{})
	reconnected := make(chan McpConnectConfig, 1)
	runtime.mu.Lock()
	runtime.disconnect = func(context.Context, string) error {
		close(disconnectEntered)
		<-releaseDisconnect
		return nil
	}
	runtime.connect = func(_ context.Context, cfg McpConnectConfig) error {
		reconnected <- cfg
		return nil
	}
	runtime.mu.Unlock()

	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "url": "https://new.example.com/mcp"}); err != nil {
		t.Fatal(err)
	}
	waitOperation(t, disconnectEntered)
	if calls := runtime.callCount(); calls != 0 {
		t.Fatalf("reconnect started before old runtime disconnected: %d", calls)
	}
	close(releaseDisconnect)
	cfg := waitOperation(t, reconnected)
	if cfg.URL != "https://new.example.com/mcp" {
		t.Fatalf("reconnected with stale config: %q", cfg.URL)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.Lock()
		live := s.live["remote"]
		active := s.operations["remote"]
		s.mu.Unlock()
		if live.Status == "connected" && active == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reconnect did not settle: live=%+v active=%v", live, active != nil)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestUpsertDoesNotAutoConnectOfflineOrDisabledServer(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(fmt.Sprint(active), func(t *testing.T) {
			s, runtime := operationService(t)
			if active {
				if _, err := s.Connect(context.Background(), "remote"); err != nil {
					t.Fatal(err)
				}
			}
			calls := runtime.callCount()
			disconnected := make(chan struct{}, 1)
			runtime.mu.Lock()
			runtime.disconnect = func(context.Context, string) error { disconnected <- struct{}{}; return nil }
			runtime.mu.Unlock()
			patch := map[string]any{"id": "remote", "command": "replacement"}
			if active {
				patch["enabled"] = false
			}
			if _, err := s.Upsert(context.Background(), patch); err != nil {
				t.Fatal(err)
			}
			waitOperation(t, disconnected)
			time.Sleep(20 * time.Millisecond)
			if runtime.callCount() != calls {
				t.Fatal("automatically connected offline/disabled service")
			}
			s.mu.Lock()
			live := s.live["remote"]
			s.mu.Unlock()
			if live.Status != "off" {
				t.Fatalf("unexpected status: %+v", live)
			}
		})
	}
}

func TestUpsertCancelsSupersededAutomaticReconnect(t *testing.T) {
	s, runtime := operationService(t)
	if _, err := s.Connect(context.Background(), "remote"); err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	runtime.mu.Lock()
	runtime.disconnect = func(context.Context, string) error { <-release; return nil }
	runtime.mu.Unlock()
	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "command": "first"}); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	op := s.operations["remote"]
	firstClose := s.closing["remote"]
	s.mu.Unlock()
	if op == nil {
		t.Fatal("automatic reconnect was not registered before saving returned")
	}
	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "command": "second", "enabled": false}); err != nil {
		t.Fatal(err)
	}
	waitOperation(t, op.ctx.Done())
	s.mu.Lock()
	secondClose := s.closing["remote"]
	s.mu.Unlock()
	// An old completion must not start a new operation after the server is disabled.
	if _, err := s.connectOperation(context.Background(), "remote", op); err != nil {
		t.Fatal(err)
	}
	if runtime.callCount() != 1 {
		t.Fatal("superseded automatic reconnect revived disabled server")
	}
	unblock()
	waitOperation(t, firstClose)
	waitOperation(t, secondClose)
}

func TestOperationHandoffIgnoresCancelledGeneration(t *testing.T) {
	for _, action := range []string{"disconnect", "delete", "delete-and-recreate"} {
		t.Run(action, func(t *testing.T) {
			s, runtime := operationService(t)
			op := pendingOperation(t, s, "remote")
			// The old completion has been scheduled, but has not acquired the connection lock.
			ready := make(chan struct{})
			release := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				close(ready)
				<-release
				_, err := s.connectOperation(context.Background(), "remote", op)
				done <- err
			}()
			waitOperation(t, ready)
			if action == "disconnect" {
				s.Disconnect(context.Background(), "remote")
			} else {
				if !s.Remove(context.Background(), "remote") {
					t.Fatal("server not removed")
				}
				if action == "delete-and-recreate" {
					if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "name": "Replacement", "transport": "stdio", "command": "node"}); err != nil {
						t.Fatal(err)
					}
				}
			}
			close(release)
			if err := waitOperation(t, done); err != nil {
				t.Errorf("stale completion returned an error: %v", err)
			}
			if n := runtime.callCount(); n != 0 {
				t.Errorf("cancelled completion started %d new connections", n)
			}
			s.mu.Lock()
			live, present := s.live["remote"]
			active := s.operations["remote"]
			s.mu.Unlock()
			if present && live.Status != "off" {
				t.Errorf("stale completion changed state to %q", live.Status)
			}
			if active != nil {
				t.Error("stale completion installed an operation")
			}
		})
	}
}

func TestAuthorizationCompletionKeepsOriginalOperation(t *testing.T) {
	for _, cancelDuringConnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "cancel-during-connect"}[cancelDuringConnect], func(t *testing.T) {
			s, runtime := operationService(t)
			op := pendingOperation(t, s, "remote")
			entered := make(chan context.Context, 1)
			release := make(chan struct{})
			runtime.connect = func(ctx context.Context, _ McpConnectConfig) error { entered <- ctx; <-release; return nil }
			done := make(chan struct{})
			go func() { s.finishAuthorization("remote", op, nil); close(done) }()
			connectCtx := waitOperation(t, entered)
			s.mu.Lock()
			same := s.operations["remote"] == op
			s.mu.Unlock()
			if !same {
				t.Error("completion replaced the original operation")
			}
			if connectCtx != op.ctx {
				t.Error("reconnect detached from the original cancellation context")
			}
			if cancelDuringConnect {
				s.Disconnect(context.Background(), "remote")
				if op.ctx.Err() != context.Canceled {
					t.Error("disconnect did not cancel the original operation")
				}
				if connectCtx.Err() != context.Canceled {
					t.Error("disconnect did not cancel the runtime connection")
				}
			}
			close(release)
			waitOperation(t, done)
			s.mu.Lock()
			live := s.live["remote"]
			active := s.operations["remote"]
			s.mu.Unlock()
			want := "connected"
			if cancelDuringConnect {
				want = "off"
			}
			if live.Status != want {
				t.Errorf("completion state %q, want %q", live.Status, want)
			}
			if active != nil {
				t.Error("completed operation was not retired")
			}
		})
	}
}

func TestOperationHandoffPreservesNewerConnection(t *testing.T) {
	s, runtime := operationService(t)
	old := pendingOperation(t, s, "remote")
	s.Disconnect(context.Background(), "remote")
	entered := make(chan struct{})
	release := make(chan struct{})
	runtime.connect = func(context.Context, McpConnectConfig) error { close(entered); <-release; return nil }
	done := make(chan error, 1)
	go func() { _, err := s.Connect(context.Background(), "remote"); done <- err }()
	waitOperation(t, entered)
	s.mu.Lock()
	current := s.operations["remote"]
	s.mu.Unlock()
	if _, err := s.connectOperation(context.Background(), "remote", old); err != nil {
		t.Error(err)
	}
	s.mu.Lock()
	preserved := s.operations["remote"] == current
	s.mu.Unlock()
	if !preserved || runtime.callCount() != 1 {
		t.Error("old completion interfered with newer connection")
	}
	close(release)
	if err := waitOperation(t, done); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorizationFailureRetiresOnlyCurrentOperation(t *testing.T) {
	s, _ := operationService(t)
	op := pendingOperation(t, s, "remote")
	s.finishAuthorization("remote", op, errors.New("failed"))
	s.mu.Lock()
	live := s.live["remote"]
	active := s.operations["remote"]
	s.mu.Unlock()
	if active != nil || live.Status != "authorization-required" || live.Auth != "required" {
		t.Fatal("failure did not retire the operation")
	}
	newer := pendingOperation(t, s, "remote")
	s.finishAuthorization("remote", op, errors.New("late failure"))
	s.mu.Lock()
	preserved := s.operations["remote"] == newer && s.live["remote"].Auth == "pending"
	s.mu.Unlock()
	if !preserved {
		t.Fatal("old failure changed newer operation")
	}
}

func TestAuthorizationCompletionHandlesUnavailableRuntime(t *testing.T) {
	s, _ := operationService(t)
	op := pendingOperation(t, s, "remote")
	s.Attach(func() McpRuntime { return nil }, operationRegistry{})
	s.finishAuthorization("remote", op, nil)
	s.mu.Lock()
	live := s.live["remote"]
	active := s.operations["remote"]
	s.mu.Unlock()
	if active != nil || live.Auth != "required" || live.Error == "" {
		t.Fatal("unavailable runtime left the completion pending")
	}
}

func TestClearAuthorizationFailureStillDisconnectsCancelledSession(t *testing.T) {
	root := t.TempDir()
	s := New(Deps{Root: filepath.Join(root, "extensions"), SkillsRoot: filepath.Join(root, "skills")})
	runtime := &operationRuntime{}
	s.Attach(func() McpRuntime { return runtime }, operationRegistry{})
	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "name": "Remote", "transport": "http", "url": "https://example.com/mcp"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Dispose)
	s.mu.Lock()
	oauth := s.oauthSession(s.find("remote"))
	s.live["remote"] = Live{Status: "connected", Tools: []LiveTool{}}
	s.mu.Unlock()
	if err := os.MkdirAll(oauth.file, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oauth.file, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ok, err := s.ClearAuthorization(context.Background(), "remote")
	if err == nil || ok {
		t.Fatalf("expected clear failure: ok=%v err=%v", ok, err)
	}
	s.mu.Lock()
	live := s.live["remote"]
	active := s.oauth["remote"]
	s.mu.Unlock()
	if live.Status != "off" || active != nil || oauth.ctx.Err() != context.Canceled {
		t.Fatalf("failed clear left a cancelled connection active: live=%+v active=%v cancelled=%v", live, active != nil, oauth.ctx.Err())
	}
	if runtime.disconnectCount() != 1 {
		t.Fatalf("runtime disconnect count %d", runtime.disconnectCount())
	}
}

func TestOAuthConfigurationChangesCancelPendingAuthorization(t *testing.T) {
	for _, change := range []map[string]any{
		{"transport": "sse"},
		{"url": "https://other.example.com/mcp"},
		{"oauthClientId": "custom-client"},
		{"headers": map[string]any{"Authorization": "Bearer manual-token"}},
	} {
		t.Run(fmt.Sprint(change), func(t *testing.T) {
			s, _ := operationService(t)
			if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "transport": "http", "url": "https://example.com/mcp"}); err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			oauth := s.oauthSession(s.find("remote"))
			s.mu.Unlock()
			op := pendingOperation(t, s, "remote")
			in := map[string]any{"id": "remote"}
			for key, value := range change {
				in[key] = value
			}
			if _, err := s.Upsert(context.Background(), in); err != nil {
				t.Fatal(err)
			}
			if op.ctx.Err() != context.Canceled || oauth.ctx.Err() != context.Canceled {
				t.Fatal("configuration change did not invalidate old authorization")
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.operations["remote"] != nil || s.live["remote"].Status != "off" {
				t.Fatal("stale authorization operation remained active")
			}
			if _, manual := change["headers"]; manual && s.oauthSession(s.find("remote")) != nil {
				t.Fatal("manual Authorization must bypass OAuth")
			}
		})
	}
}

type blockedOAuthBox struct {
	security.SecretBox
	entered chan struct{}
	release chan struct{}
}

func (b *blockedOAuthBox) Encrypt(value, unavailable string) (string, error) {
	close(b.entered)
	<-b.release
	return b.SecretBox.Encrypt(value, unavailable)
}

func TestOAuthInvalidationWaitsForInflightCredentialWrite(t *testing.T) {
	s, _ := operationService(t)
	if _, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "transport": "http", "url": "https://example.com/mcp"}); err != nil {
		t.Fatal(err)
	}
	box := &blockedOAuthBox{SecretBox: security.NewMemoryBox(), entered: make(chan struct{}), release: make(chan struct{})}
	s.d.Secrets = box
	s.mu.Lock()
	oauth := s.oauthSession(s.find("remote"))
	s.mu.Unlock()
	saving := make(chan error, 1)
	go func() {
		v := oauth.snapshot()
		v.Tokens = &oauthCredentials{AccessToken: "test-access-token"}
		saving <- oauth.save(v)
	}()
	waitOperation(t, box.entered)
	invalidating := make(chan error, 1)
	go func() {
		_, err := s.Upsert(context.Background(), map[string]any{"id": "remote", "url": "https://other.example.com/mcp"})
		invalidating <- err
	}()
	waitOperation(t, oauth.ctx.Done())
	select {
	case <-invalidating:
		close(box.release)
		t.Fatal("invalidation returned while an old credential write was still blocked")
	case <-time.After(20 * time.Millisecond):
	}
	close(box.release)
	if err := waitOperation(t, saving); err != nil {
		t.Fatal(err)
	}
	if err := waitOperation(t, invalidating); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oauth.file); !os.IsNotExist(err) {
		t.Fatalf("old credentials reappeared after configuration change: %v", err)
	}
}
