package gwstore

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceRuntimeStartsGateway(t *testing.T) {
	// 网关 worker 在 Stop 后异步处理 "stop"（sessions.json 落盘，同 Node fork 子进程），不用 t.TempDir 以免清理竞争
	dir, err := os.MkdirTemp("", "gwrt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for i := 0; i < 50 && os.RemoveAll(dir) != nil; i++ {
			time.Sleep(20 * time.Millisecond)
		}
	})
	s := NewServiceForUserData(dir, nil, nil)
	changed := 0
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Env: map[string]string{}})
	s.OnChange(func() { changed++ })
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	// stop 时网关 worker 异步落盘 sessions.json（同 Node：stop 不等 worker 退出）；先等落盘再让 TempDir 清理
	defer func() {
		s.Dispose()
		for i := 0; i < 200; i++ {
			if _, err := os.Stat(filepath.Join(dir, "sessions.json")); err == nil {
				time.Sleep(20 * time.Millisecond)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	if !s.WhenReady(5 * time.Second) {
		t.Fatalf("not ready: %+v", s.Status())
	}
	if st := s.Status(); st.State != "running" || st.URL == "" {
		t.Fatalf("status %+v", st)
	}
	if ep := s.Endpoint("nomi"); ep == nil || ep.Token == "" {
		t.Fatalf("endpoint %+v", ep)
	}
	if r := s.NomiRoute("main"); r != nil {
		t.Fatalf("no models configured, want nil route, got %+v", r)
	}
	if rc := s.RuntimeConfig(); rc.Get("routePlan") != "active" || rc.Get("sessionsFile") == nil {
		t.Fatalf("runtimeConfig %s", rc)
	}
}
