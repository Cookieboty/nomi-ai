package usage

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type nopLogger struct{}

func (nopLogger) Info(string, any) {}
func (nopLogger) Warn(string, any) {}

func gwEv(kv ...any) *util.Obj {
	o := util.NewObj("client", "nomi", "wire", "responses", "provider", "amux", "model", "amux/openai/gpt-6-astra",
		"upstreamModel", "openai/gpt-6-astra", "status", float64(200), "startedAt", float64(1_793_507_645_592), "ms", float64(8725))
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func TestRecordGateway(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	zero := float64(0)
	var s *UsageService
	jsrt.Run(func() {
		s = NewUsageService(ServiceDeps{Root: root, Home: &home, Logger: nopLogger{}, ScanMs: &zero,
			Now: func() float64 { return 1_793_507_700_000 }})
	})
	t.Cleanup(func() { jsrt.Run(s.Stop) })
	jsrt.Run(func() {
		a := s.RecordGateway(gwEv("usage", util.NewObj("inputTokens", float64(30369), "outputTokens", float64(208))))
		b := s.RecordGateway(gwEv("startedAt", float64(1_793_507_677_049),
			"usage", util.NewObj("inputTokens", float64(30735), "outputTokens", float64(33), "cacheReadTokens", float64(30366))))
		if a == nil || a.Input != 30369 || a.CacheRead != 0 || a.Output != 208 || a.Model != "openai/gpt-6-astra" || a.Provider == nil || *a.Provider != "amux" {
			t.Fatalf("a=%+v", a)
		}
		if b == nil || b.Input != 369 || b.CacheRead != 30366 || b.Output != 33 || a.Key == b.Key {
			t.Fatalf("b=%+v", b)
		}
		m := s.RecordGateway(gwEv("wire", "messages", "usage", util.NewObj("inputTokens", float64(12), "outputTokens", float64(5),
			"cacheReadTokens", float64(1000), "cacheWriteTokens", float64(50))))
		if m == nil || m.Input != 12 || m.CacheRead != 1000 || m.CacheWrite != 50 {
			t.Fatalf("m=%+v", m)
		}
		if s.RecordGateway(gwEv("status", float64(502), "usage", util.NewObj("inputTokens", float64(10)))) != nil ||
			s.RecordGateway(gwEv("client", "codex", "usage", util.NewObj("inputTokens", float64(10)))) != nil ||
			s.RecordGateway(gwEv("usage", util.NewObj())) != nil {
			t.Fatal("失败 / 别的客户端 / 没有用量不记")
		}
	})
}
