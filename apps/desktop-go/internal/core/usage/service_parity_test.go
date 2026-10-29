package usage

// UsageService parity：回放 scripts/parity/record-usage-service.mjs 录下的 Node 真实 UsageService 操作序列
// （假时钟 + 空 home + 离线），逐步比较返回值（按键顺序序列化后比对）、提醒与落盘的 settings / alerts。

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

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

func TestUsageServiceParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "usage-service.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		TZ        string `json:"tz"`
		Scenarios []struct {
			Name string            `json:"name"`
			Ops  []json.RawMessage `json:"ops"`
			Outs []json.RawMessage `json:"outs"`
		} `json:"scenarios"`
		T0 float64 `json:"t0"`
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
			dsh := filepath.Join(home, ".dsh")
			now := fx.T0
			zero := 0.0
			var alerts []any
			var s *UsageService
			jsrt.Run(func() {
				s = NewUsageService(ServiceDeps{
					Root: filepath.Join(dir, "usage"), Home: &home, DshHome: &dsh, Now: func() float64 { return now }, ScanMs: &zero,
					Platform: "linux", Env: util.NewObj("HOME", home), Logger: svcNopLog{}, Publish: func(string, any) {},
					ProviderName: func(id string) (string, bool) { return "Provider One", id == "p1" },
					Alert: func(a UsageAlert) bool {
						alerts = append(alerts, util.NewObj("kind", a.Kind, "title", a.Title, "text", a.Text))
						return true
					},
					PriceFetch:  func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") },
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
				})
			})
			t.Cleanup(func() { jsrt.Run(s.Stop) })
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
					now += arg(1).(float64)
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
