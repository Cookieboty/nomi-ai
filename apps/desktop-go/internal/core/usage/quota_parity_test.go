package usage

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 回放 scripts/parity/record-usage-quota.mjs 的录制：quota / quotaCache / quotaIdentity。

type qWin struct {
	ID            string `json:"id"`
	UsedPercent   any    `json:"usedPercent"`
	WindowMinutes any    `json:"windowMinutes"`
	ResetAt       any    `json:"resetAt"`
}

type qReading struct {
	Windows   []qWin  `json:"windows"`
	UpdatedAt float64 `json:"updatedAt"`
	Plan      any     `json:"plan"` // string 或 {"$js":"proto"|"fn"}（recorder jsPlan 标记）
	Origin    string  `json:"origin"`
	Stale     bool    `json:"stale"`
}

func qNum(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		switch x {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		case "-0":
			return math.Copysign(0, -1)
		}
	}
	panic("bad num")
}

func (w qWin) toWin() QuotaWindow {
	o := QuotaWindow{ID: w.ID, UsedPercent: qNum(w.UsedPercent)}
	if w.WindowMinutes != nil {
		o.WindowMinutes = f64p(qNum(w.WindowMinutes))
	}
	if w.ResetAt != nil {
		o.ResetAt = f64p(qNum(w.ResetAt))
	}
	return o
}

func (r *qReading) toReading() *QuotaReading {
	if r == nil {
		return nil
	}
	ws := make([]QuotaWindow, len(r.Windows))
	for i, w := range r.Windows {
		ws[i] = w.toWin()
	}
	out := &QuotaReading{Windows: ws, UpdatedAt: r.UpdatedAt, Origin: r.Origin, Stale: r.Stale}
	switch p := r.Plan.(type) {
	case string:
		out.Plan = p
	case map[string]any:
		if p["$js"] == "proto" {
			out.PlanKind = PlanObjectProto
		} else {
			out.PlanKind = PlanFunction
		}
	}
	return out
}

type qOutcome struct {
	Kind     string    `json:"kind"`
	Reading  *qReading `json:"reading"`
	Identity *string   `json:"identity"`
	Reason   string    `json:"reason"`
}

func (o qOutcome) toOutcome() FetchOutcome {
	return FetchOutcome{Kind: o.Kind, Reading: o.Reading.toReading(), Identity: o.Identity, Reason: o.Reason}
}

type qOp struct {
	Op           string             `json:"op"`
	Out          string             `json:"out"`
	Changes      int                `json:"changes"`
	Now          float64            `json:"now"`
	Placeholders []QuotaPlaceholder `json:"placeholders"`
	ID           string             `json:"id"`
	Src          *struct {
		ID      string    `json:"id"`
		Label   string    `json:"label"`
		Throws  bool      `json:"throws"`
		None    bool      `json:"none"`
		UseNow  bool      `json:"useNow"`
		Reading *qReading `json:"reading"`
	} `json:"src"`
	TTL           float64   `json:"ttl"`
	ThrowOnChange bool      `json:"throwOnChange"`
	Ms            float64   `json:"ms"`
	Fp            *string   `json:"fp"`
	Identity      *string   `json:"identity"`
	Value         *qReading `json:"value"`
	As            string    `json:"as"`
	P             string    `json:"p"`
	A             string    `json:"a"`
	B             string    `json:"b"`
	D             string    `json:"d"`
	V             *qOutcome `json:"v"`
	Load          *struct {
		Now     *qOutcome `json:"now"`
		Defer   string    `json:"defer"`
		Throws  bool      `json:"throws"`
		Rejects bool      `json:"rejects"`
	} `json:"load"`
}

type quotaGolden struct {
	TTL      float64 `json:"ttl"`
	Sanitize []struct {
		Now     float64 `json:"now"`
		Windows []qWin  `json:"windows"`
		Out     string  `json:"out"`
	} `json:"sanitize"`
	Registry [][]qOp `json:"registry"`
	Cache    [][]qOp `json:"cache"`
	Fps      []struct {
		Salt  string `json:"salt"`
		Parts []any  `json:"parts"`
		Out   string `json:"out"`
	} `json:"fps"`
	Salts []struct {
		Name          string  `json:"name"`
		Content       *string `json:"content"`
		Kept          bool    `json:"kept"`
		Valid         bool    `json:"valid"`
		DiskIsSalt    bool    `json:"diskIsSalt"`
		DiskUnchanged bool    `json:"diskUnchanged"`
		Mode          *int    `json:"mode"`
	} `json:"salts"`
}

func loadQuotaGolden(t *testing.T) quotaGolden {
	t.Helper()
	path, _ := paritytest.Golden(t, "usage-quota.json", "testdata/usage-quota.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g quotaGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

// jsOut = 录制端的 S(v)：undefined → "__undef__"，其余 JSON.stringify。
func jsOut(v any) string {
	switch x := v.(type) {
	case nil:
		return "__undef__"
	case interface{ ToObj() *util.Obj }:
		return util.Stringify(x.ToObj())
	}
	return util.Stringify(v)
}

func entriesAny(es []QuotaEntry) []any {
	out := make([]any, len(es))
	for i, e := range es {
		out[i] = e.ToObj()
	}
	return out
}

func TestQuotaParitySanitize(t *testing.T) {
	g := loadQuotaGolden(t)
	if g.TTL != QuotaTTLMs {
		t.Fatalf("QUOTA_TTL_MS %v != %v", QuotaTTLMs, g.TTL)
	}
	if len(g.Sanitize) == 0 {
		t.Fatal("empty golden")
	}
	for i, c := range g.Sanitize {
		ws := make([]QuotaWindow, len(c.Windows))
		for j, w := range c.Windows {
			ws[j] = w.toWin()
		}
		if got := util.Stringify(windowsAny(SanitizeWindows(ws, c.Now))); got != c.Out {
			t.Errorf("sanitize #%d:\n got %s\nwant %s", i, got, c.Out)
		}
	}
}

func TestQuotaParityRegistry(t *testing.T) {
	g := loadQuotaGolden(t)
	n := 0
	for si, ops := range g.Registry {
		reg := NewQuotaRegistry()
		for oi, o := range ops {
			switch o.Op {
			case "register":
				s := o.Src
				reg.Register(QuotaSource{ID: s.ID, Label: s.Label, Read: func(now float64) *QuotaReading {
					if s.Throws {
						panic(jsrt.JSThrow{Message: "boom"})
					}
					if s.None {
						return nil
					}
					r := s.Reading.toReading()
					if s.UseNow {
						r.UpdatedAt = now
					}
					return r
				}})
			case "unregister":
				reg.Unregister(o.ID)
			case "collect":
				n++
				if got := util.Stringify(entriesAny(reg.Collect(o.Now, o.Placeholders))); got != o.Out {
					t.Errorf("registry %d op %d:\n got %s\nwant %s", si, oi, got, o.Out)
				}
			default:
				t.Fatalf("unknown op %s", o.Op)
			}
		}
	}
	if n == 0 {
		t.Fatal("no collect ops")
	}
}

func TestQuotaParityCache(t *testing.T) {
	g := loadQuotaGolden(t)
	for si, ops := range g.Cache {
		jsrt.Run(func() { runCacheScript(t, si, ops) })
	}
}

func runCacheScript(t *testing.T, si int, ops []qOp) {
	clock := 1_000_000.0
	changes := 0
	var c *IdentityQuotaCache
	ps := map[string]*jsrt.Promise[RefreshResult]{}
	ds := map[string]*jsrt.Promise[FetchOutcome]{}
	flush := func() { jsrt.Sleep(30 * time.Millisecond) }
	for oi, o := range ops {
		var r any
		switch o.Op {
		case "new":
			c = NewIdentityQuotaCache(func() float64 { return clock }, o.TTL)
			throw := o.ThrowOnChange
			c.SetOnChange(func() {
				changes++
				if throw {
					panic(jsrt.JSThrow{Message: "disk"})
				}
			})
		case "tick":
			clock += o.Ms
		case "get":
			if v := c.Get(); v != nil {
				r = v.ToObj()
			} else {
				r = jsNull{}
			}
		case "snapshot":
			if v := c.Snapshot(); v != nil {
				r = v.ToObj()
			} else {
				r = jsNull{}
			}
		case "retry":
			r = c.RetryInMs()
		case "ident":
			if v := c.CurrentIdentity(); v != nil {
				r = *v
			} else {
				r = jsNull{}
			}
		case "isStale":
			r = c.IsStale()
		case "clear":
			c.Clear()
		case "observe":
			r = c.ObserveIdentity(o.Fp)
		case "restore":
			r = c.Restore(o.Identity, o.Value.toReading())
		case "refresh":
			l := o.Load
			ps[o.As] = c.Refresh(o.Fp, func() *jsrt.Promise[FetchOutcome] {
				switch {
				case l.Throws:
					panic(jsrt.JSThrow{Message: "sync"})
				case l.Rejects:
					return jsrt.Rejected[FetchOutcome](jsrt.JSThrow{Message: "async"})
				case l.Defer != "":
					p := jsrt.NewPromise[FetchOutcome]()
					ds[l.Defer] = p
					return p
				}
				return jsrt.Resolved(l.Now.toOutcome())
			})
		case "same":
			r = ps[o.A] == ps[o.B]
		case "settle":
			ds[o.D].Resolve(o.V.toOutcome())
			flush()
		case "fail":
			ds[o.D].Reject(jsrt.JSThrow{Message: "x"})
			flush()
		case "await":
			// await 总会让出到微任务队列（jsrt.Await 对已结算 promise 走捷径，不让出）
			flush()
			v, err := jsrt.Await(ps[o.P])
			if err != nil {
				t.Fatalf("cache %d op %d: %v", si, oi, err)
			}
			r = v.ToObj()
		default:
			t.Fatalf("unknown op %s", o.Op)
		}
		got := "__undef__"
		if _, ok := r.(jsNull); ok {
			got = "null"
		} else if r != nil {
			got = jsOut(r)
		}
		if got != o.Out || changes != o.Changes {
			t.Errorf("cache %d op %d (%s):\n got %s changes=%d\nwant %s changes=%d", si, oi, o.Op, got, changes, o.Out, o.Changes)
		}
	}
}

type jsNull struct{}

func TestQuotaParityIdentity(t *testing.T) {
	g := loadQuotaGolden(t)
	for i, c := range g.Fps {
		parts := make([]*string, len(c.Parts))
		for j, p := range c.Parts {
			if s, ok := p.(string); ok && s != "__undef__" {
				parts[j] = &s
			}
		}
		fp, ok := Fingerprint(c.Salt, parts)
		got := "null"
		if ok {
			got = util.Stringify(fp)
		}
		if got != c.Out {
			t.Errorf("fingerprint #%d: got %s want %s", i, got, c.Out)
		}
	}
	const salt = "0123456789abcdef0123456789abcdef"
	hex32 := regexp.MustCompile(`^[0-9a-f]{32}$`)
	tmp := t.TempDir()
	for _, c := range g.Salts {
		dir := filepath.Join(tmp, filepath.FromSlash(c.Name))
		if c.Content != nil {
			if err := os.MkdirAll(dir, 0o777); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "quota-salt"), []byte(*c.Content), 0o666); err != nil {
				t.Fatal(err)
			}
		}
		s := LoadSalt(dir)
		f := filepath.Join(dir, "quota-salt")
		b, err := os.ReadFile(f)
		disk := string(b)
		got := []bool{s == salt, hex32.MatchString(s), err == nil && disk == s, err == nil && c.Content != nil && disk == *c.Content}
		want := []bool{c.Kept, c.Valid, c.DiskIsSalt, c.DiskUnchanged}
		for k := range got {
			if got[k] != want[k] {
				t.Errorf("loadSalt %s: got %v want %v", c.Name, got, want)
				break
			}
		}
		if c.Mode != nil && runtime.GOOS != "windows" {
			st, err := os.Stat(f)
			if err != nil || int(st.Mode().Perm()) != *c.Mode {
				t.Errorf("loadSalt %s mode: %v want %o", c.Name, st.Mode().Perm(), *c.Mode)
			}
		}
	}
}
