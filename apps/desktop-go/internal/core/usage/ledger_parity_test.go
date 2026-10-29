package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type ledgerScenario struct {
	Name    string              `json:"name"`
	Now     *float64            `json:"now"`
	Pre     *string             `json:"pre"`
	Cursors json.RawMessage     `json:"cursors"`
	Sync    *int64              `json:"sync"`
	Ops     [][]json.RawMessage `json:"ops"`
	Out     []json.RawMessage   `json:"out"`
}

type attrArg struct {
	Session      string   `json:"session"`
	Project      string   `json:"project"`
	CacheWrite1h *float64 `json:"cacheWrite1h"`
	Fast         bool     `json:"fast"`
	LogKey       string   `json:"logKey"`
}

type hintArg struct {
	Key     string  `json:"key"`
	Session *string `json:"session"`
	Prompt  float64 `json:"prompt"`
	Output  float64 `json:"output"`
}

func (l *UsageLedger) waitIdle() {
	for i := 0; i < 2000; i++ {
		l.mu.Lock()
		idle := l.compactRunning == nil && l.compactQueued == nil && !l.cursorWriting
		l.mu.Unlock()
		if idle {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

func un[T any](t *testing.T, b json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("arg %s: %v", b, err)
	}
	return v
}

func TestUsageLedgerParity(t *testing.T) {
	path, _ := paritytest.Golden(t, "usage-ledger.json", "testdata/usage-ledger.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Scenarios []ledgerScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	const T0 = 1_780_000_000_000
	steps, pass := 0, 0
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "usage")
			_ = os.MkdirAll(dir, 0o700)
			if sc.Pre != nil {
				_ = os.WriteFile(filepath.Join(dir, "ledger.jsonl"), []byte(*sc.Pre), 0o600)
			}
			if len(sc.Cursors) > 0 && string(sc.Cursors) != "null" {
				_ = os.WriteFile(filepath.Join(dir, "cursors.json"), sc.Cursors, 0o600)
			}
			now := float64(T0 + 86_400_000)
			if sc.Now != nil {
				now = *sc.Now
			}
			flushMs := 3_600_000.0
			var gate chan struct{}
			open := func() *UsageLedger {
				if sc.Sync != nil {
					gate = make(chan struct{})
					testLoadGate = gate
				}
				l := NewUsageLedger(LedgerDeps{Root: dir, FlushMs: &flushMs, Now: func() float64 { return now }, SyncLoadMaxBytes: sc.Sync})
				testLoadGate = nil
				return l
			}
			l := open()
			readFile := func() []byte {
				b, err := os.ReadFile(filepath.Join(dir, "ledger.jsonl"))
				if err != nil {
					return nil
				}
				return b
			}
			for i, op := range sc.Ops {
				name := un[string](t, op[0])
				a := op[1:]
				var v any
				switch name {
				case "upsert":
					r := un[UsageRecord](t, a[0])
					v = l.Upsert(&r)
				case "attribute":
					p := un[attrArg](t, a[1])
					v = l.Attribute(un[string](t, a[0]), AttributePatch{p.Session, p.Project, p.CacheWrite1h, p.Fast, p.LogKey})
				case "get":
					if r := l.Get(un[string](t, a[0])); r != nil {
						v = r
					} else {
						v = "__undef__"
					}
				case "has":
					v = l.Has(un[string](t, a[0]))
				case "size":
					v = l.Size()
				case "version":
					v = l.Version()
				case "range":
					v = l.Range(un[float64](t, a[0]), un[float64](t, a[1]))
				case "lastTs":
					if ts, ok := l.LastTs(un[string](t, a[0])); ok {
						v = ts
					}
				case "all":
					v = l.All()
				case "persist":
					v = l.PersistState()
				case "flush":
					l.Flush()
				case "close":
					l.Close()
				case "reopen":
					l = open()
				case "file":
					b := readFile()
					if b != nil {
						arr := []any{}
						for _, x := range strings.Split(string(b), "\n") {
							var p any
							if json.Unmarshal([]byte(x), &p) != nil {
								p = map[string]any{"__raw": x}
							}
							arr = append(arr, p)
						}
						v = arr
					}
				case "lineCount":
					n := 0
					for _, x := range strings.Split(string(readFile()), "\n") {
						if x != "" {
							n++
						}
					}
					v = n
				case "cursorsFile":
					if b, err := os.ReadFile(filepath.Join(dir, "cursors.json")); err == nil {
						var p any
						_ = json.Unmarshal(b, &p)
						v = p
					}
				case "covered":
					v = l.CoveredByRoute(un[string](t, a[0]), un[float64](t, a[1]))
				case "routeCovering":
					h := un[hintArg](t, a[2])
					if r := l.RouteCovering(un[string](t, a[0]), un[float64](t, a[1]), &RouteHint{h.Key, h.Session, h.Prompt, h.Output}); r != nil {
						v = r.Key
					}
				case "setCursor":
					c := un[FileCursor](t, a[1])
					l.SetCursor(un[string](t, a[0]), &c)
				case "dropCursor":
					l.DropCursor(un[string](t, a[0]))
				case "cursor":
					if c := l.Cursor(un[string](t, a[0])); c != nil {
						v = c
					} else {
						v = "__undef__"
					}
				case "cursorPaths":
					v = l.CursorPaths()
				case "prune":
					v = l.Prune(un[string](t, a[0]))
				case "clear":
					l.Clear()
				case "compactWait":
					<-l.Compact()
					l.waitIdle()
				case "settle":
					time.Sleep(5 * time.Millisecond)
					l.waitIdle()
				case "breakFile":
					f := filepath.Join(dir, "ledger.jsonl")
					_ = os.RemoveAll(f)
					_ = os.Mkdir(f, 0o700)
				case "fixFile":
					_ = os.RemoveAll(filepath.Join(dir, "ledger.jsonl"))
				case "isLoaded":
					v = l.IsLoaded()
				case "ready":
					if gate != nil {
						close(gate)
						gate = nil
					}
					l.WhenReady()
					l.waitIdle()
				case "appendRaw":
					f, _ := os.OpenFile(filepath.Join(dir, "ledger.jsonl"), os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600)
					_, _ = f.WriteString(un[string](t, a[0]))
					f.Close()
					l.Close()
					l = open()
				default:
					t.Fatalf("unknown op %s", name)
				}
				steps++
				var want any
				_ = json.Unmarshal(sc.Out[i], &want)
				gv := normJSON(t, v)
				if !deepEq(gv, want) {
					gb, _ := json.Marshal(gv)
					t.Errorf("step %d %s: got %s want %s", i, name, gb, sc.Out[i])
					continue
				}
				pass++
			}
			l.Close()
		})
	}
	t.Logf("usage ledger parity: %d/%d steps", pass, steps)
}
