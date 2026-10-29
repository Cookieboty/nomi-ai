package quality

import (
	"context"
	"encoding/json"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func call(r *contract.Router, name string, in json.RawMessage) (any, *contract.ErrorPayload) {
	ch := make(chan contract.ServerFrame, 1)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat", ID: 1}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	fr, _ := json.Marshal(contract.ClientFrame{T: "req", ID: "1", Kind: "call", Name: name, Input: in})
	s.Handle(fr)
	f := <-ch
	return f.Output, f.Error
}

func TestQualityValidationGolden(t *testing.T) {
	// 提交的 golden 固定 3 个时区（TZ 子进程录制；CI 只在 Linux 现场重录并 diff，见 desktop-go.yml）
	p := "testdata/quality.json"
	raw, _ := os.ReadFile(p)
	var g struct {
		Validation []struct {
			Proc  string          `json:"proc"`
			Input json.RawMessage `json:"input"`
			OK    bool            `json:"ok"`
		} `json:"validation"`
	}
	if err := json.Unmarshal(raw, &g); err != nil || len(g.Validation) == 0 {
		t.Fatal("no validation cases", err)
	}
	svc := New(ServiceDeps{Dir: t.TempDir(), FlushMs: -1})
	defer svc.Dispose()
	r := contract.NewRouter()
	Install(r, func() *Service { return svc })
	for _, c := range g.Validation {
		_, e := call(r, c.Proc, c.Input)
		bad := e != nil && e.Code == "BAD_INPUT"
		if bad == c.OK {
			t.Errorf("%s %s: node ok=%v, go err=%v", c.Proc, c.Input, c.OK, e)
		}
	}
	// 服务缺席 → UNAVAILABLE
	r2 := contract.NewRouter()
	Install(r2, func() *Service { return nil })
	if _, e := call(r2, "quality.getSettings", nil); e == nil || e.Code != "UNAVAILABLE" {
		t.Fatalf("want UNAVAILABLE, got %v", e)
	}
}

func TestQualityBroadcastAndBatch(t *testing.T) {
	var n atomic.Int32
	dir := t.TempDir()
	now := float64(time.Date(2026, 10, 29, 12, 0, 0, 0, time.Local).UnixMilli())
	svc := New(ServiceDeps{Dir: dir, FlushMs: 30, BroadcastMs: 40, Now: func() float64 { return now },
		Publish: func(ev string, p any) {
			if ev == "quality.changed" && p == nil {
				n.Add(1)
			}
		}})
	rec := func(i int) *u.Obj {
		return u.NewObj("ts", now, "client", "x", "source", "nomi", "stream", true, "status", 200.0, "outcome", "ok", "timing", u.NewObj("endMs", 1.0), "tokens", u.NewObj(), "model", "m", "id", "c"+string(rune('a'+i)))
	}
	for i := 0; i < 3; i++ {
		if svc.AddCli(rec(i)) == nil {
			t.Fatal("addCli rejected")
		}
	}
	file := dir + "/" + DayKey(now) + ".jsonl"
	if _, err := os.Stat(file); err == nil {
		t.Fatal("written before flush window")
	}
	if got := len(svc.Ledger.Range(now-1, now+1)); got != 3 {
		t.Fatalf("pending visible: %d", got)
	}
	time.Sleep(120 * time.Millisecond)
	b, _ := os.ReadFile(file)
	if c := len(splitLines(string(b))); c != 3 {
		t.Fatalf("flushed lines %d", c)
	}
	if n.Load() != 1 {
		t.Fatalf("broadcasts %d (want 1, throttled)", n.Load())
	}
	// 关总开关：不记
	off := New(ServiceDeps{Dir: t.TempDir(), FlushMs: -1, Enabled: func() bool { return false }})
	defer off.Dispose()
	if off.AddCli(rec(0)) != nil || off.Add(rec(1)) {
		t.Fatal("recorded while disabled")
	}
	lg := rec(2)
	lg.Set("layer", "gateway")
	if err := off.ImportLegacy([]*u.Obj{lg, u.NewObj("bad", true)}); err != nil {
		t.Fatal(err)
	}
	if g := off.Ledger.Range(now-1, now+1); len(g) != 1 {
		t.Fatal("legacy import ignores switch")
	}
	svc.Dispose()
}

func splitLines(s string) []string {
	out := []string{}
	for _, l := range []byte(s) {
		_ = l
	}
	cur := ""
	for _, ch := range s {
		if ch == '\n' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(ch)
	}
	return out
}
