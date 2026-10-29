package gwstore

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceRuntimeStartsGateway(t *testing.T) {
	dir := t.TempDir() // Dispose 等网关循环退出，TempDir 清理时不再有写入
	s := NewServiceForUserData(dir, nil, nil)
	changed := 0
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Env: map[string]string{}})
	s.OnChange(func() { changed++ })
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer func() {
		// Dispose 等网关循环结束（Stop + sessions 落盘）后才返回
		s.Dispose()
		if _, err := os.Stat(filepath.Join(dir, "sessions.json")); err != nil {
			t.Errorf("sessions.json not flushed before Dispose returned: %v", err)
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
