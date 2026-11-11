package cli

import (
	"errors"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"os"
	"path/filepath"
	"testing"
)

func TestHistoryDeleteWaitsForRunningSession(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "exit", true: "stop-failure"}[fail], func(t *testing.T) {
			home := t.TempDir()
			file := filepath.Join(home, ".claude", "projects", "work", "running.jsonl")
			if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte(`{"type":"user","sessionId":"running","message":{"role":"user","content":"test session"}}`+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			var stopped *jsrt.Promise[struct{}]
			var removal *jsrt.Promise[*util.Obj]
			open, deleted := true, false
			jsrt.Run(func() {
				stopped = jsrt.NewPromise[struct{}]()
				service := NewSessionHistoryService(SessionHistoryDeps{
					Home: home, HasHome: true, Env: util.NewObj(),
					OpenKeys: func() map[string]bool { return map[string]bool{"claude:running": open} },
					CloseSession: func(backend, id string) *jsrt.Promise[struct{}] {
						if backend != "claude" || id != "running" {
							t.Fatalf("wrong session %s:%s", backend, id)
						}
						return stopped
					},
					RemovePath: func(path string) *jsrt.Promise[struct{}] {
						if open || !stopped.Settled() {
							t.Fatal("deleted before process exit")
						}
						deleted = true
						return jsrt.Async(func() (struct{}, error) { return struct{}{}, os.RemoveAll(path) })
					},
				})
				removal = service.Remove("claude", "running")
				if removal.Settled() || deleted {
					t.Fatal("delete must await the process")
				}
				if fail {
					stopped.Reject(errors.New("could not stop"))
				} else {
					open = false
					stopped.Resolve(struct{}{})
				}
			})
			result, err := jsrt.Block(removal)
			if err != nil {
				t.Fatal(err)
			}
			if result.Get("ok") != !fail || deleted == fail {
				t.Fatalf("result=%s deleted=%v", util.Stringify(result), deleted)
			}
			if fail {
				if _, err := os.Stat(file); err != nil {
					t.Fatal("failed stop must preserve the transcript")
				}
			} else if _, err := os.Stat(file); !os.IsNotExist(err) {
				t.Fatalf("transcript remains: %v", err)
			}
		})
	}
}

func TestHistoryDeleteTabUsesCurrentIdentity(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, ".claude", "projects", "work", "native.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"type":"user","sessionId":"native","message":{"role":"user","content":"test session"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var removal *jsrt.Promise[*util.Obj]
	jsrt.Run(func() {
		// The UI opened its confirmation before the native identity was published.
		current := util.NewObj("backend", "claude", "sessionId", "")
		closed, deleted := false, false
		service := NewSessionHistoryService(SessionHistoryDeps{
			Home: home, HasHome: true, Env: util.NewObj(),
			TabSession: func(id string) *util.Obj {
				if id != "tab" {
					t.Fatalf("wrong tab %s", id)
				}
				return current
			},
			CloseTab: func(string) *jsrt.Promise[struct{}] {
				t.Error("native session must use the process exit barrier")
				return jsrt.Resolved(struct{}{})
			},
			CloseSession: func(backend, id string) *jsrt.Promise[struct{}] {
				if backend != "claude" || id != "native" {
					t.Fatalf("stale session %s:%s", backend, id)
				}
				closed = true
				return jsrt.Resolved(struct{}{})
			},
			RemovePath: func(path string) *jsrt.Promise[struct{}] {
				if !closed {
					t.Error("deleted before closing current session")
				}
				deleted = true
				return jsrt.Resolved(struct{}{})
			},
		})
		current.Set("sessionId", "native") // Arrives while the confirmation dialog is open.
		removal = service.RemoveTab("tab")
		result, err := jsrt.Await(removal)
		if err != nil || result.Get("ok") != true || !deleted {
			t.Fatalf("result=%v err=%v deleted=%v", result, err, deleted)
		}
	})
}

func TestHistoryDeleteTabWithoutNativeSession(t *testing.T) {
	for _, exists := range []bool{false, true} {
		jsrt.Run(func() {
			closed := false
			service := NewSessionHistoryService(SessionHistoryDeps{
				TabSession: func(id string) *util.Obj {
					if !exists {
						return nil
					}
					return util.NewObj("backend", "claude", "sessionId", "")
				},
				CloseTab: func(id string) *jsrt.Promise[struct{}] {
					if id != "tab" {
						t.Fatalf("wrong tab %s", id)
					}
					closed = true
					return jsrt.Resolved(struct{}{})
				},
				CloseSession: func(string, string) *jsrt.Promise[struct{}] { t.Fatal("no native session to delete"); return nil },
			})
			result, err := jsrt.Await(service.RemoveTab("tab"))
			if err != nil || result.Get("ok") != exists || closed != exists {
				t.Fatalf("result=%v err=%v closed=%v", result, err, closed)
			}
		})
	}
}

func TestHistoryPermanentDeleteRemovesRecordAndAttachments(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "work")
	file, attachments := filepath.Join(dir, "native.jsonl"), filepath.Join(dir, "native")
	if err := os.MkdirAll(attachments, 0700); err != nil {
		t.Fatal(err)
	}
	for path, data := range map[string]string{
		file:                                    `{"type":"user","sessionId":"native","message":{"role":"user","content":"permanent delete"}}` + "\n",
		filepath.Join(attachments, "image.png"): "attachment",
		filepath.Join(dir, "unrelated.jsonl"):   `{"type":"user","sessionId":"unrelated","message":{"role":"user","content":"keep"}}` + "\n",
	} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	jsrt.Run(func() {
		service := NewSessionHistoryService(SessionHistoryDeps{
			Home: home, HasHome: true, Env: util.NewObj(),
			RemovePath: func(path string) *jsrt.Promise[struct{}] {
				return jsrt.Async(func() (struct{}, error) { return struct{}{}, os.RemoveAll(path) })
			},
		})
		result, err := jsrt.Await(service.Remove("claude", "native"))
		if err != nil || result.Get("ok") != true {
			t.Fatalf("result=%v err=%v", result, err)
		}
		for _, path := range []string{file, attachments} {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Errorf("permanent deletion left %s: %v", path, err)
			}
		}
		if _, err := os.Stat(filepath.Join(dir, "unrelated.jsonl")); err != nil {
			t.Fatal("unrelated history was deleted", err)
		}
		for _, f := range service.sessionFiles("claude", "claude:native") {
			t.Errorf("deleted session still listed: %s", f.Path)
		}
	})
}
