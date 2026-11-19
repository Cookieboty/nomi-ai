package gwstore

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestServiceRuntimeStartsGateway(t *testing.T) {
	dir := t.TempDir() // Dispose 等网关循环退出，TempDir 清理时不再有写入
	s := NewServiceForUserData(dir, nil, nil)
	var changed atomic.Int32
	// 端口 0 = 系统分配：默认 18721 在整仓并行 go test（或本机正跑着的 Nomi）下会被占用，是不稳定的根因
	port := 0
	s.AttachRuntime(RuntimeDeps{Root: dir, Lazy: true, Port: &port, Env: map[string]string{}})
	s.OnChange(func() { changed.Add(1) })
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
	if !s.WhenReady(30 * time.Second) {
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

	// 熔断降级默认关闭；通过 SetOptions 开启并关闭后同步反映到 State 与 RuntimeConfig
	stDefault := s.State()
	if stDefault.Get("failoverEnabled") != false {
		t.Fatalf("expected default failoverEnabled=false, got %v", stDefault.Get("failoverEnabled"))
	}
	if s.RuntimeConfig().Get("failoverEnabled") != nil {
		t.Fatalf("expected runtimeConfig failoverEnabled unset by default, got %v", s.RuntimeConfig().Get("failoverEnabled"))
	}
	stOn, err := s.SetOptions(mustObj(t, `{"failoverEnabled":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if stOn.Get("failoverEnabled") != true || s.RuntimeConfig().Get("failoverEnabled") != true {
		t.Fatalf("expected failoverEnabled=true in state and runtime, got state=%v runtime=%v",
			stOn.Get("failoverEnabled"), s.RuntimeConfig().Get("failoverEnabled"))
	}
	stOff, err := s.SetOptions(mustObj(t, `{"failoverEnabled":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if stOff.Get("failoverEnabled") != false || s.RuntimeConfig().Get("failoverEnabled") != nil {
		t.Fatalf("expected failoverEnabled=false after toggle off, got state=%v runtime=%v",
			stOff.Get("failoverEnabled"), s.RuntimeConfig().Get("failoverEnabled"))
	}
}
