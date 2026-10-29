package gwstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// GatewayProcess 生命周期 golden（scripts/parity/record-gwprocess.mjs）：fork / post / kill / status / log / timer / ready 序列逐步比对。

type gpGolden struct {
	Scenarios []struct {
		Name string `json:"name"`
		Opts struct {
			Lazy       bool `json:"lazy"`
			FuseMax    int  `json:"fuseMax"`
			FuseWindow int  `json:"fuseWindow"`
		} `json:"opts"`
		Trace []struct {
			Op     []any             `json:"op"`
			Events []json.RawMessage `json:"events"`
			Status json.RawMessage   `json:"status"`
		} `json:"trace"`
	} `json:"scenarios"`
}

type gpRec struct {
	mu sync.Mutex
	ev []any
}

func (r *gpRec) add(e map[string]any) { r.mu.Lock(); r.ev = append(r.ev, e); r.mu.Unlock() }
func (r *gpRec) take() []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.ev
	r.ev = nil
	if e == nil {
		e = []any{}
	}
	return e
}

type gpLog struct{ r *gpRec }

func (l gpLog) Info(m string, _ any) { l.r.add(map[string]any{"log": "info", "msg": m}) }
func (l gpLog) Warn(m string, _ any) { l.r.add(map[string]any{"log": "warn", "msg": m}) }

type gpChild struct {
	idx  int
	r    *gpRec
	msg  func(server.WorkerOutbound)
	exit func(int)
}

func (c *gpChild) PostMessage(m server.WorkerInbound) {
	c.r.add(map[string]any{"post": c.idx, "type": m.Type})
}
func (c *gpChild) OnMessage(fn func(m server.WorkerOutbound)) { c.msg = fn }
func (c *gpChild) OnExit(fn func(code int))                   { c.exit = fn }
func (c *gpChild) Kill() bool                                 { c.r.add(map[string]any{"kill": c.idx}); return true }

func normJSON(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var x any
	_ = json.Unmarshal(b, &x)
	b, _ = json.Marshal(x)
	return string(b)
}

func TestGatewayProcessParity(t *testing.T) {
	p := filepath.Join("testdata", "gwprocess.json")
	if d := os.Getenv("NOMI_LIVE_GOLDENS"); d != "" {
		if _, err := os.Stat(filepath.Join(d, "gwprocess.json")); err == nil {
			p = filepath.Join(d, "gwprocess.json")
		}
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g gpGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) != 6 {
		t.Fatalf("scenarios = %d", len(g.Scenarios))
	}
	origAfter := afterFunc
	defer func() { afterFunc = origAfter }()

	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			r := &gpRec{}
			clock := 1793500000000.0
			var children []*gpChild
			type tmr struct {
				t *time.Timer
				f func()
			}
			var timers []tmr
			afterFunc = func(d time.Duration, f func()) *time.Timer {
				r.add(map[string]any{"timer": d.Milliseconds()})
				tt := time.AfterFunc(time.Hour, f)
				timers = append(timers, tmr{tt, f})
				return tt
			}
			gp := NewGatewayProcess(ProcessDeps{
				Logger:     gpLog{r},
				OnStatus:   func(s GatewayStatus) { r.add(map[string]any{"status": s.Obj()}) },
				Now:        func() float64 { return clock },
				Lazy:       sc.Opts.Lazy,
				FuseMax:    sc.Opts.FuseMax,
				FuseWindow: sc.Opts.FuseWindow,
				Fork: func() GatewayChild {
					c := &gpChild{idx: len(children), r: r}
					children = append(children, c)
					r.add(map[string]any{"fork": c.idx})
					return c
				},
			})
			defer gp.Stop()
			child := func(op []any) *gpChild {
				if len(op) > 1 {
					return children[int(op[1].(float64))]
				}
				if len(children) == 0 {
					return nil
				}
				return children[len(children)-1]
			}
			cfg := gwConfigForTest()
			ready := make(chan bool, 16)
			for i, st := range sc.Trace {
				op := st.Op
				switch op[0].(string) {
				case "apply":
					gp.Apply(cfg)
				case "ensureStarted":
					gp.EnsureStarted()
				case "whenReady":
					go func() { ready <- gp.WhenReady(time.Hour) }()
				case "listening":
					if c := child(op); c != nil && c.msg != nil {
						c.msg(server.WorkerOutbound{Type: "listening", Port: 18999, URL: "http://127.0.0.1:18999"})
					}
				case "fatal":
					if c := child(op); c != nil && c.msg != nil {
						c.msg(server.WorkerOutbound{Type: "error", Message: "EADDRINUSE", Fatal: true})
					}
				case "error":
					if c := child(op); c != nil && c.msg != nil {
						c.msg(server.WorkerOutbound{Type: "error", Message: "soft"})
					}
				case "exit":
					if c := child(op); c != nil && c.exit != nil {
						c.exit(1)
					}
				case "advance":
					clock += op[1].(float64)
				case "fireTimer":
					if n := len(timers); n > 0 && timers[n-1].t.Stop() {
						timers[n-1].f()
					}
				case "retry":
					gp.Retry()
				case "stop":
					gp.Stop()
				default:
					t.Fatalf("op %v", op)
				}
				// whenReady 的结果（Node：微任务里落到本步末尾）
				deadline := time.After(30 * time.Millisecond)
			drain:
				for {
					select {
					case ok := <-ready:
						r.add(map[string]any{"ready": ok})
					case <-deadline:
						break drain
					}
				}
				got := splitTimers(t, r.take())
				want := splitTimers(t, st.Events)
				if got != want {
					t.Fatalf("step %d %v events:\n go:   %s\n node: %s", i, op, got, want)
				}
				if gs, ws := normJSON(t, gp.GetStatus().Obj()), normJSON(t, st.Status); gs != ws {
					t.Fatalf("step %d %v status: go %s node %s", i, op, gs, ws)
				}
			}
		})
	}
}

func gwConfigForTest() *u.Obj {
	v, _ := u.ParseString(`{"port":18999,"providers":[]}`)
	return v.(*u.Obj)
}

// splitTimers：把 timer（退避定时器的 delay）抽出单独比对。定时器装上不是可观察事件；Go 的 onStatus 在解锁后回调
// （避免回调里读状态死锁），所以「装定时器」与「status」的相对先后不比，其余事件严格按序比。
func splitTimers(t *testing.T, ev any) string {
	var xs []any
	_ = json.Unmarshal([]byte(normJSON(t, ev)), &xs)
	rest, timers := []any{}, []any{}
	for _, x := range xs {
		if m, ok := x.(map[string]any); ok {
			if _, ok := m["timer"]; ok {
				timers = append(timers, x)
				continue
			}
		}
		rest = append(rest, x)
	}
	return normJSON(t, map[string]any{"events": rest, "timers": timers})
}
