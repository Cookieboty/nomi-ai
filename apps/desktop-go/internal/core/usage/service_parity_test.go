package usage

// UsageService parity：回放 scripts/parity/record-usage-service.mjs 录下的 Node 真实 UsageService 操作序列
// （假时钟 + 空 home + 离线），逐步比较返回值（按键顺序序列化后比对）、提醒与落盘的 settings / alerts。

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type svcNopLog struct{}

func (svcNopLog) Info(string, any) {}
func (svcNopLog) Warn(string, any) {}

const svcUndef = `"__undef__"`

func svcF(o *util.Obj, k string) float64 { v, _ := o.Get(k).(float64); return v }
func svcS(o *util.Obj, k string) string  { v, _ := o.Get(k).(string); return v }
func svcFp(o *util.Obj, k string) *float64 {
	if v, ok := o.Get(k).(float64); ok {
		return &v
	}
	return nil
}

// svcInputOf：录制里的 UsageInput 对象 → UsageInput（缺省字段 = undefined）
func svcInputOf(o *util.Obj) UsageInput {
	in := UsageInput{Ts: svcF(o, "ts"), Dur: svcFp(o, "dur"), Source: svcS(o, "source"), Via: svcS(o, "via"),
		Provider: svcS(o, "provider"), Model: svcS(o, "model"), PromptTokens: svcF(o, "promptTokens"), OutputTokens: svcF(o, "outputTokens"),
		CacheRead: svcFp(o, "cacheRead"), CacheWrite: svcFp(o, "cacheWrite"), CacheWrite1h: svcFp(o, "cacheWrite1h"),
		Fast: o.Get("fast") == true, Est: o.Get("est") == true, Session: svcS(o, "session"), Project: svcS(o, "project"), Rid: svcS(o, "rid")}
	if k, ok := o.Get("key").(string); ok {
		in.Key = &k
	}
	return in
}

func svcRouteEndOf(o *util.Obj) RouteEndInput {
	r := RouteEndInput{StartedAt: svcF(o, "startedAt"), Provider: svcS(o, "provider"), Model: svcS(o, "model")}
	if u, ok := o.Get("usage").(*util.Obj); ok {
		su := &SniffedUsage{Input: svcF(u, "input"), Output: svcF(u, "output"), CacheRead: svcF(u, "cacheRead"), CacheWrite: svcF(u, "cacheWrite"), CacheWrite1h: svcFp(u, "cacheWrite1h")}
		if v, ok := u.Get("model").(string); ok {
			su.Model = &v
		}
		if v, ok := u.Get("id").(string); ok {
			su.ID = &v
		}
		if u.Get("fast") == true {
			t := true
			su.Fast = &t
		}
		r.Usage = su
	}
	return r
}

func svcCostQueryOf(o *util.Obj) CostQuery {
	return CostQuery{Source: svcS(o, "source"), Since: svcF(o, "since"), Session: svcS(o, "session")}
}

// svcJSON：Go 返回值 → 与 Node JSON.stringify 同口径（键顺序保留）
func svcJSON(t *testing.T, v any) string {
	t.Helper()
	switch x := v.(type) {
	case *util.Obj, []any, string, float64, bool, nil:
		return util.Stringify(x)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	p, err := util.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return util.Stringify(p)
}

func await[T any](t *testing.T, mk func() *jsrt.Promise[T]) T {
	t.Helper()
	var p *jsrt.Promise[T]
	jsrt.Run(func() { p = mk() })
	v, err := jsrt.Block(p)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// svcFakeTimer：usage.changed 去抖的假时钟队列（与录制脚本的 setTimeout 拦截同口径）
type svcFakeTimer struct {
	due float64
	seq int
	fn  func()
	tm  *jsrt.Timer
}

func svcEntries(es []QuotaEntry) []any {
	out := make([]any, len(es))
	for i, e := range es {
		out[i] = e.ToObj()
	}
	return out
}

// svcClaudeSettings：~/.claude/settings.json 的结构摘要（不含路径，跨平台可比）
func svcClaudeSettings(home string) any {
	b, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return nil
	}
	v, err := util.Parse(b)
	if err != nil {
		return "invalid"
	}
	keys := []any{}
	var sl any
	if o, ok := v.(*util.Obj); ok {
		for _, k := range o.Keys() {
			keys = append(keys, k)
		}
		sl = o.Get("statusLine")
	} else if a, ok := v.([]any); ok {
		for i := range a {
			keys = append(keys, util.Stringify(float64(i)))
		}
	}
	out := util.NewObj("keys", keys, "statusLine", nil)
	if so, ok := sl.(*util.Obj); ok {
		sk := []any{}
		for _, k := range so.Keys() {
			sk = append(sk, k)
		}
		or := func(k string) any {
			if v := so.Get(k); v != nil {
				return v
			}
			return nil
		}
		cmd, _ := so.Get("command").(string)
		out.Set("statusLine", util.NewObj("keys", sk, "type", or("type"), "padding", or("padding"), "ours", strings.Contains(cmd, "claude-statusline.sh")))
	}
	return out
}

func TestUsageServiceParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "usage-service.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		TZ        string `json:"tz"`
		Scenarios []struct {
			Name    string            `json:"name"`
			Pre     map[string]string `json:"pre"`
			Auth    map[string]string `json:"auth"`
			AlertOk bool              `json:"alertOk"`
			GrokKey *string           `json:"grokKey"`
			Ops     []json.RawMessage `json:"ops"`
			Outs    []json.RawMessage `json:"outs"`
		} `json:"scenarios"`
		T0       float64 `json:"t0"`
		Salt     string  `json:"salt"`
		CuOk     string  `json:"cuOk"`
		Snapshot string  `json:"snapshot"`
		GoodAPI  string  `json:"goodApi"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	withTZ(t, fx.TZ)
	for _, sc := range fx.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			dir := t.TempDir()
			home := filepath.Join(dir, "home")
			if err := os.Mkdir(home, 0o700); err != nil {
				t.Fatal(err)
			}
			write := func(rel, c string) {
				f := filepath.Join(dir, filepath.FromSlash(rel))
				if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(f, []byte(c), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			write("usage/quota-salt", fx.Salt)
			for f, c := range sc.Pre {
				write(f, c)
			}
			dsh := filepath.Join(home, ".dsh")
			now := fx.T0
			zero := 0.0
			var alerts, events, fetches, modelsData, claudeRuns []any
			var mu sync.Mutex
			auth := map[string]string{}
			for k, v := range sc.Auth {
				auth[k] = v
			}
			alertOk, needsFull, fetchMode := sc.AlertOk, false, "good"
			claudeOut, claudeDefer := "", false
			var claudePending []func()
			var started, started2 *jsrt.Promise[QuotaRefreshReport]
			// 假时钟队列（持锁访问）
			var fakeQ []*svcFakeTimer
			fakeSeq := 0
			prevST := svcSetTimeout
			svcSetTimeout = func(d time.Duration, fn func()) *jsrt.Timer {
				fakeSeq++
				ft := &svcFakeTimer{due: now + float64(d/time.Millisecond), seq: fakeSeq, fn: fn, tm: &jsrt.Timer{}}
				fakeQ = append(fakeQ, ft)
				return ft.tm
			}
			t.Cleanup(func() { svcSetTimeout = prevST })
			var s *UsageService
			jsrt.Run(func() {
				d := ServiceDeps{
					Root: filepath.Join(dir, "usage"), Home: &home, DshHome: &dsh, Now: func() float64 { return now }, ScanMs: &zero,
					Platform: "linux", Env: util.NewObj("HOME", home), Logger: svcNopLog{},
					Publish:      func(name string, _ any) { events = append(events, []any{now - fx.T0, name}) },
					ProviderName: func(id string) (string, bool) { return "Provider One", id == "p1" },
					Alert: func(a UsageAlert) bool {
						alerts = append(alerts, util.NewObj("kind", a.Kind, "title", a.Title, "text", a.Text))
						return alertOk
					},
					PriceFetch: func(req *http.Request) (*http.Response, error) {
						var inm any
						if v := req.Header.Get("If-None-Match"); v != "" {
							inm = v
						}
						mu.Lock()
						fetches = append(fetches, util.NewObj("url", req.URL.String(), "inm", inm))
						mode := fetchMode
						mu.Unlock()
						resp := func(code int, body string, h http.Header) *http.Response {
							return &http.Response{StatusCode: code, Header: h, Body: io.NopCloser(strings.NewReader(body))}
						}
						switch mode {
						case "offline":
							return nil, errors.New("offline")
						case "304":
							return resp(304, "", http.Header{}), nil
						case "500":
							return resp(500, "no", http.Header{}), nil
						}
						h := http.Header{}
						h.Set("etag", `"e1"`)
						return resp(200, fx.GoodAPI, h), nil
					},
					OnModelsData: func(api any) error {
						n := 0
						if o, ok := api.(*util.Obj); ok {
							n = len(o.Keys())
						}
						mu.Lock()
						modelsData = append(modelsData, float64(n))
						mu.Unlock()
						return nil
					},
					NeedsFullModelsData: func() bool { mu.Lock(); defer mu.Unlock(); return needsFull },
					AuthRun: func(kind string) (string, bool) {
						mu.Lock()
						defer mu.Unlock()
						v, ok := auth[kind]
						return v, ok
					},
					ClaudeUsage: &ClaudeFetcherDeps{
						ResolveBin: func() (string, bool) { return "/bin/claude", true },
						Run: func(cmd string, args []string, _ RunOptions) *jsrt.Promise[RunResult] {
							claudeRuns = append(claudeRuns, strings.Join(append([]string{cmd}, args...), " "))
							p := jsrt.NewPromise[RunResult]()
							code := 0
							if !claudeDefer {
								p.Resolve(RunResult{Stdout: claudeOut, Code: &code})
								return p
							}
							claudePending = append(claudePending, func() { p.Resolve(RunResult{Stdout: claudeOut, Code: &code}) })
							return p
						},
					},
					CodexRPC:    &CodexRPCDeps{ResolveBin: func() (string, bool) { return "", false }},
					GrokBilling: &GrokBillingDeps{ResolveBin: func() (string, bool) { return "", false }},
					WithCliPath: func(e *util.Obj) *util.Obj { o := e.Clone(); o.Set("PATH", "stub"); return o },
					AccountEnv: func(k string, e *util.Obj, d *string) *util.Obj {
						o := e.Clone()
						v := ""
						if d != nil {
							v = *d
						}
						o.Set("ACC", k+":"+v)
						return o
					},
					ZstdDecode: func([]byte) (string, error) { return "", errors.New("zstd") },
				}
				if sc.GrokKey != nil {
					k := *sc.GrokKey
					d.GrokAccountKey = func() *string { return &k }
				}
				s = NewUsageService(d)
			})
			claudeOut = fx.CuOk
			t.Cleanup(func() { jsrt.Run(s.Stop) })
			waitPending := func(p *jsrt.Promise[QuotaRefreshReport]) float64 {
				for i := 0; i < 400; i++ {
					done := false
					jsrt.Run(func() { done = len(claudePending) > 0 || p.Settled() })
					if done {
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				var n int
				jsrt.Run(func() { n = len(claudePending) })
				return float64(n)
			}
			report := func(p *jsrt.Promise[QuotaRefreshReport]) *util.Obj {
				v, err := jsrt.Block(p)
				if err != nil {
					t.Fatal(err)
				}
				return v.ToObj()
			}
			for i, rawOp := range sc.Ops {
				pv, err := util.Parse(rawOp)
				if err != nil {
					t.Fatal(err)
				}
				op := pv.([]any)
				name := op[0].(string)
				arg := func(n int) any { return op[n] }
				obj := func(n int) *util.Obj { o, _ := op[n].(*util.Obj); return o }
				got := svcUndef
				set := func(v any) { got = svcJSON(t, v) }
				switch name {
				case "advance":
					jsrt.Run(func() { now += arg(1).(float64) })
				case "alerts":
					set(append([]any{}, alerts...))
					alerts = nil
				case "files":
					o := util.NewObj()
					for _, f := range []string{"settings.json", "alerts.json"} {
						b, err := os.ReadFile(filepath.Join(dir, "usage", f))
						if err != nil {
							o.Set(f, nil)
							continue
						}
						v, err := util.Parse(b)
						if err != nil {
							t.Fatal(err)
						}
						o.Set(f, v)
					}
					set(o)
				case "getSettings":
					jsrt.Run(func() { set(s.GetSettings().ToObj()) })
				case "setSettings":
					jsrt.Run(func() {
						v, err := s.SetSettings(obj(1))
						if err != nil {
							t.Fatal(err)
						}
						set(v.ToObj())
					})
				case "record":
					jsrt.Run(func() {
						if r := s.Record(svcInputOf(obj(1))); r != nil {
							set(r)
						} else {
							set(nil)
						}
					})
				case "routeBegin":
					jsrt.Run(func() { s.RouteBegin(arg(1).(string)) })
				case "routeEnd":
					jsrt.Run(func() { s.RouteEnd(arg(1).(string), svcRouteEndOf(obj(2))) })
				case "checkBudgets":
					jsrt.Run(s.CheckBudgets)
				case "readState":
					set(await(t, s.ReadState))
				case "readQuery":
					set(await(t, func() *jsrt.Promise[*util.Obj] { return s.ReadQuery(arg(1)) }))
				case "readHeatmap":
					set(await(t, s.ReadHeatmap))
				case "readEndpoint":
					set(await(t, func() *jsrt.Promise[*util.Obj] { return s.ReadEndpoint(arg(1)) }))
				case "readDetails":
					set(await(t, func() *jsrt.Promise[DetailResult] { return s.ReadDetails(arg(1)) }))
				case "readCsv":
					set(await(t, func() *jsrt.Promise[string] { return s.ReadCsv(arg(1)) }))
				case "costOf":
					jsrt.Run(func() {
						if v, ok := s.CostOf(arg(1).(string), obj(2)); ok {
							set(v)
						}
					})
				case "longContextPrice":
					jsrt.Run(func() {
						if v := s.LongContextPrice(arg(1).(string)); v != nil {
							set(v)
						}
					})
				case "sessionUsage":
					jsrt.Run(func() {
						if v := s.SessionUsage(arg(1).(string), arg(2).(string)); v != nil {
							set(v.ToObj())
						} else {
							set(nil)
						}
					})
				case "costSince":
					jsrt.Run(func() {
						if v := s.CostSince(svcCostQueryOf(obj(1))); v != nil {
							set(v.ToObj())
						} else {
							set(nil)
						}
					})
				case "taskCostLine":
					jsrt.Run(func() {
						if v := s.TaskCostLine(svcCostQueryOf(obj(1))); v != "" {
							set(v)
						} else {
							set(nil)
						}
					})
				case "clearWithState":
					jsrt.Run(func() {
						v, err := s.ClearWithState()
						if err != nil {
							t.Fatal(err)
						}
						set(v)
					})
				case "alertOk":
					jsrt.Run(func() { alertOk = arg(1).(bool) })
				case "quotaFile":
					if b, err := os.ReadFile(filepath.Join(dir, "usage", "quota.json")); err == nil {
						set(string(b))
					} else {
						set(nil)
					}
				case "claudeSettings":
					set(svcClaudeSettings(home))
				case "writeHome":
					write("home/"+arg(1).(string), arg(2).(string))
				case "snapshot":
					write("usage/"+StatuslineSnapshotFile, fx.Snapshot)
					tm := time.UnixMilli(int64(now))
					if err := os.Chtimes(filepath.Join(dir, "usage", StatuslineSnapshotFile), tm, tm); err != nil {
						t.Fatal(err)
					}
				case "setAuth":
					mu.Lock()
					auth[arg(1).(string)] = arg(2).(string)
					mu.Unlock()
				case "claudeOut":
					jsrt.Run(func() { claudeOut = arg(1).(string) })
				case "claudeDefer":
					jsrt.Run(func() { claudeDefer = arg(1).(bool) })
				case "claudeRuns":
					jsrt.Run(func() { set(append([]any{}, claudeRuns...)); claudeRuns = nil })
				case "needsFull":
					mu.Lock()
					needsFull = arg(1).(bool)
					mu.Unlock()
				case "fetchMode":
					mu.Lock()
					fetchMode = arg(1).(string)
					mu.Unlock()
				case "fetches":
					mu.Lock()
					set(append([]any{}, fetches...))
					fetches = nil
					mu.Unlock()
				case "modelsData":
					mu.Lock()
					set(append([]any{}, modelsData...))
					modelsData = nil
					mu.Unlock()
				case "events":
					jsrt.Run(func() { set(append([]any{}, events...)); events = nil })
				case "tick":
					target := now + arg(1).(float64)
					for {
						var next *svcFakeTimer
						jsrt.Run(func() {
							sort.SliceStable(fakeQ, func(i, j int) bool {
								if fakeQ[i].due != fakeQ[j].due {
									return fakeQ[i].due < fakeQ[j].due
								}
								return fakeQ[i].seq < fakeQ[j].seq
							})
							// 被 ClearTimeout 的不再触发
							for len(fakeQ) > 0 && s.broadcast != fakeQ[0].tm {
								fakeQ = fakeQ[1:]
							}
							if len(fakeQ) > 0 && fakeQ[0].due <= target {
								next = fakeQ[0]
								fakeQ = fakeQ[1:]
								now = next.due
								next.fn()
							}
						})
						if next == nil {
							break
						}
					}
					now = target
				case "clear":
					jsrt.Run(func() {
						if err := s.Clear(); err != nil {
							t.Fatal(err)
						}
					})
				case "forgetAccountQuota":
					jsrt.Run(func() { s.ForgetAccountQuota(arg(1).(string)) })
				case "quotaViewed":
					set(svcEntries(await(t, s.QuotaViewed)))
				case "quotaHookStatus":
					jsrt.Run(func() { set(s.QuotaHookStatus().ToObj()) })
				case "setQuotaHook":
					jsrt.Run(func() {
						v, err := s.SetQuotaHook(arg(1).(bool))
						if err != nil {
							set(util.NewObj("error", err.Error()))
							return
						}
						set(v.ToObj())
					})
				case "refreshQuota":
					tool := ""
					if len(op) > 1 {
						tool, _ = op[1].(string)
					}
					set(await(t, func() *jsrt.Promise[QuotaRefreshReport] { return s.RefreshQuota(tool) }).ToObj())
				case "refreshDedupe":
					tool := ""
					if len(op) > 1 {
						tool, _ = op[1].(string)
					}
					var p1, p2 *jsrt.Promise[QuotaRefreshReport]
					jsrt.Run(func() { p1 = s.RefreshQuota(tool); p2 = s.RefreshQuota(tool) })
					started = p1
					set(util.NewObj("same", p1 == p2, "pending", waitPending(p1)))
				case "refreshStart":
					jsrt.Run(func() { started = s.RefreshQuota(arg(1).(string)) })
					set(util.NewObj("pending", waitPending(started)))
				case "refreshStart2":
					jsrt.Run(func() { started2 = s.RefreshQuota(""); set(util.NewObj("pending", float64(len(claudePending)))) })
				case "sameStarted":
					jsrt.Run(func() {
						set(util.NewObj("same", s.RefreshQuota("claude") == started, "all", s.RefreshQuota("") == started2))
					})
				case "release":
					jsrt.Run(func() {
						set(float64(len(claudePending)))
						ps := claudePending
						claudePending = nil
						for _, r := range ps {
							r()
						}
					})
				case "refreshAwait":
					set(report(started))
				case "refreshAwait2":
					set(report(started2))
				case "syncPrices":
					set(await(t, s.SyncPrices))
				case "autoSync":
					await(t, s.AutoSync)
				case "scanWithState":
					set(await(t, s.ScanWithState))
				default:
					t.Fatalf("unknown op %s", name)
				}
				wv, err := util.Parse(sc.Outs[i])
				if err != nil {
					t.Fatal(err)
				}
				if want := util.Stringify(wv); got != want {
					t.Errorf("op %d %s:\n got  %s\n want %s", i, rawOp, got, want)
				}
			}
		})
	}
}
