package gwstore

import (
	"testing"
	"time"
)

func TestServiceRuntimeStartsGateway(t *testing.T) {
	dir := t.TempDir()
	s := NewServiceForUserData(dir, nil, nil)
	changed := 0
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Env: map[string]string{}})
	s.OnChange(func() { changed++ })
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	s.Start()
	defer s.Dispose()
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
