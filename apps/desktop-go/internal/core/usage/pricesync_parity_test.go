package usage

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type psStep struct {
	Status  int               `json:"status"`
	Body    *string           `json:"body"`
	Headers map[string]string `json:"headers"`
	Throws  bool              `json:"throws"`
}

type psScen struct {
	Name         string          `json:"name"`
	File         *string         `json:"file"`
	Steps        []psStep        `json:"steps"`
	NeedsFull    bool            `json:"needsFull"`
	OnDataThrows bool            `json:"onDataThrows"`
	Init         json.RawMessage `json:"init"`
	Results      []struct {
		R       string         `json:"r"`
		State   PriceSyncState `json:"state"`
		Version int            `json:"version"`
		Entries int            `json:"entries"`
	} `json:"results"`
	Saved      *string `json:"saved"`
	AfterReset *struct {
		State   PriceSyncState `json:"state"`
		Version int            `json:"version"`
		Exists  bool           `json:"exists"`
	} `json:"afterReset"`
	Seen []struct {
		URL         string            `json:"url"`
		Method      string            `json:"method"`
		Headers     map[string]string `json:"headers"`
		Redirect    string            `json:"redirect"`
		Credentials string            `json:"credentials"`
	} `json:"seen"`
	Warns []string `json:"warns"`
	Datas []int    `json:"datas"`
}

func entriesJSON(es []PriceEntry) string {
	a := make([]any, len(es))
	for i, e := range es {
		a[i] = PriceEntryObj(e)
	}
	return util.Stringify(a)
}

func TestPriceSyncParity(t *testing.T) {
	withTZ(t, "America/New_York")
	raw, err := os.ReadFile("testdata/usage-pricesync.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Costs, CostOut, Apis, ExtractOut, SyncedIn, SyncedOut []string
		Now                                                   float64
		Scen                                                  []psScen
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	p := func(s string) any { v, _ := util.ParseString(s); return v }
	for i, c := range g.Costs {
		got := "null"
		if r := ReadModelsDevCost(p(c)); r != nil {
			o := PriceEntryObj(PriceEntry{ModelPrice: *r})
			o.Delete("model")
			got = util.Stringify(o)
		}
		if got != g.CostOut[i] {
			t.Errorf("cost %d %s:\n got %s\nwant %s", i, c, got, g.CostOut[i])
		}
	}
	for i, a := range g.Apis {
		r := ExtractPrices(p(a))
		got := `{"entries":` + entriesJSON(r.Entries) + `,"skipped":` + util.Stringify(float64(r.Skipped)) + `}`
		if got != g.ExtractOut[i] {
			t.Errorf("extract %d:\n got %s\nwant %s", i, got, g.ExtractOut[i])
		}
	}
	for i, s := range g.SyncedIn {
		if got := entriesJSON(SanitizeSyncedEntries(p(s))); got != g.SyncedOut[i] {
			t.Errorf("synced %d:\n got %s\nwant %s", i, got, g.SyncedOut[i])
		}
	}
	for _, s := range g.Scen {
		t.Run(s.Name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "usage")
			f := filepath.Join(dir, "price-sync.json")
			if s.File != nil {
				_ = os.MkdirAll(dir, 0o755)
				_ = os.WriteFile(f, []byte(*s.File), 0o644)
			}
			warns, i := []string{}, 0
			datas := []int{}
			type seenT struct {
				url, method string
				h           http.Header
			}
			var seen []seenT
			ps := NewPriceSync(PriceSyncDeps{
				Root: dir, Now: func() float64 { return g.Now + float64(i)*1000 }, Logger: psWarnLog{&warns},
				NeedsFull: func() bool { return s.NeedsFull },
				OnData: func(api any) error {
					n := 0
					if o, ok := api.(*util.Obj); ok {
						n = len(o.Keys())
					}
					datas = append(datas, n)
					if s.OnDataThrows {
						return errors.New("x")
					}
					return nil
				},
				FetchImpl: func(req *http.Request) (*http.Response, error) {
					st := s.Steps[i]
					seen = append(seen, seenT{req.URL.String(), req.Method, req.Header.Clone()})
					if st.Throws {
						return nil, errors.New("down")
					}
					code := st.Status
					if code == 0 {
						code = 200
					}
					h := http.Header{}
					for k, v := range st.Headers {
						h.Set(k, v)
					}
					body := ""
					if st.Body != nil {
						body = *st.Body
					}
					return &http.Response{StatusCode: code, Header: h, Body: io.NopCloser(strings.NewReader(body))}, nil
				},
			})
			init := util.NewObj().Set("state", stateObj(ps.State())).Set("entries", entriesJSON(ps.Entries())).Set("version", float64(ps.Version()))
			if got, want := util.Stringify(init), compactJSON(s.Init); got != want {
				t.Errorf("init:\n got %s\nwant %s", got, want)
			}
			for k, want := range s.Results {
				r := ps.Sync()
				i++
				if got := util.Stringify(r.Obj()); got != want.R {
					t.Errorf("step %d result %s want %s", k, got, want.R)
				}
				if ps.State() != want.State || ps.Version() != want.Version || len(ps.Entries()) != want.Entries {
					t.Errorf("step %d state %+v v%d n%d want %+v v%d n%d", k, ps.State(), ps.Version(), len(ps.Entries()), want.State, want.Version, want.Entries)
				}
			}
			time.Sleep(150 * time.Millisecond)
			// 后台缓存写盘结束后再离开（否则与其它测试改 time.Local 竞争，-race 报告）
			_, _ = jsrt.Block(utils.WhenPrivateWritesIdle())
			b, err := os.ReadFile(f)
			if (err == nil) != (s.Saved != nil) || (s.Saved != nil && string(b) != *s.Saved) {
				t.Errorf("saved:\n got %s\nwant %v", b, s.Saved)
			}
			if s.AfterReset != nil {
				ps.Reset()
				_, err := os.Stat(f)
				if ps.State() != s.AfterReset.State || ps.Version() != s.AfterReset.Version || (err == nil) != s.AfterReset.Exists {
					t.Errorf("reset mismatch")
				}
			}
			if len(seen) != len(s.Seen) {
				t.Fatalf("seen %d want %d", len(seen), len(s.Seen))
			}
			for k, w := range s.Seen {
				sv := seen[k]
				if sv.url != w.URL || sv.method != w.Method || len(sv.h) != len(w.Headers) {
					t.Errorf("seen %d: %v want %+v", k, sv, w)
				}
				for hk, hv := range w.Headers {
					if sv.h.Get(hk) != hv {
						t.Errorf("seen %d header %s=%q want %q", k, hk, sv.h.Get(hk), hv)
					}
				}
			}
			if strings.Join(warns, "\n") != strings.Join(s.Warns, "\n") || util.Stringify(intsAny(datas)) != util.Stringify(intsAny(s.Datas)) {
				t.Errorf("warns %q datas %v want %q %v", warns, datas, s.Warns, s.Datas)
			}
		})
	}
}

func stateObj(s PriceSyncState) *util.Obj {
	return util.NewObj().Set("count", s.Count).Set("fetchedAt", s.FetchedAt).Set("checkedAt", s.CheckedAt).Set("tableDate", s.TableDate)
}

func compactJSON(r json.RawMessage) string { v, _ := util.Parse(r); return util.Stringify(v) }

func intsAny(a []int) []any {
	r := make([]any, len(a))
	for i, v := range a {
		r[i] = float64(v)
	}
	return r
}

type psWarnLog struct{ w *[]string }

func (psWarnLog) Info(string, any) {}
func (l psWarnLog) Warn(m string, d any) {
	*l.w = append(*l.w, fmt.Sprintf("%s | %v", m, d))
}

// TestPriceSyncRedirectParity：defaultPriceFetch 与 Node 全局 fetch（undici）对同一组重定向的请求序列、
// 每跳收到的请求头（凭据头剥离、无 Referer、缺省头）与最终结果逐条一致。
func TestPriceSyncRedirectParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/usage-pricesync.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Redirects []struct {
			Path   string `json:"path"`
			Result string `json:"result"`
			Hits   []struct {
				At     string            `json:"at"`
				Method string            `json:"method"`
				H      map[string]string `json:"h"`
			} `json:"hits"`
		} `json:"redirects"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	keep := []string{"authorization", "cookie", "proxy-authorization", "x-keep", "referer", "accept", "accept-encoding", "accept-language", "sec-fetch-mode", "user-agent", "content-length"}
	type hit struct {
		at, method string
		h          map[string]string
	}
	var mu sync.Mutex
	var hits []hit
	urls := map[string]string{}
	mk := func(label string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := map[string]string{}
			for _, k := range keep {
				if vs := r.Header.Values(k); len(vs) > 0 {
					h[k] = strings.Join(vs, ", ")
				}
			}
			mu.Lock()
			hits = append(hits, hit{label + r.URL.RequestURI(), r.Method, h})
			A, B := urls["A"], urls["B"]
			mu.Unlock()
			goTo := func(st int, loc string) {
				if loc != "" {
					w.Header().Set("Location", loc)
				}
				w.WriteHeader(st)
			}
			u := r.URL.RequestURI()
			switch {
			case u == "/same":
				goTo(302, "/final")
			case u == "/cross":
				goTo(302, B+"/final")
			case u == "/back":
				goTo(302, B+"/toA")
			case u == "/toA":
				goTo(302, A+"/final")
			case u == "/see":
				goTo(303, "/final")
			case u == "/tmp":
				goTo(307, "final")
			case u == "/perm":
				goTo(308, B+"/final")
			case strings.HasPrefix(u, "/chain/"):
				n, _ := strconv.Atoi(u[7:])
				if n > 0 {
					goTo(302, fmt.Sprintf("/chain/%d", n-1))
				} else {
					_, _ = w.Write([]byte("ok"))
				}
			case u == "/noloc":
				goTo(301, "")
			case u == "/ftp":
				goTo(302, "ftp://x/")
			default:
				_, _ = w.Write([]byte("ok"))
			}
		}))
	}
	a, b := mk("A"), mk("B")
	defer a.Close()
	defer b.Close()
	urls["A"], urls["B"] = a.URL, b.URL
	for _, c := range g.Redirects {
		t.Run(c.Path, func(t *testing.T) {
			mu.Lock()
			hits = nil
			mu.Unlock()
			req, _ := http.NewRequest(http.MethodGet, a.URL+c.Path, nil)
			req.Header.Set("Accept", "application/json")
			req.Header.Set("Accept-Encoding", "br, gzip")
			req.Header.Set("Authorization", "Bearer t")
			req.Header.Set("Cookie", "c=1")
			req.Header.Set("Proxy-Authorization", "Basic p")
			req.Header.Set("X-Keep", "k")
			var result string
			resp, err := defaultPriceFetch(req)
			if err != nil {
				result = jsString(err)
			} else {
				body, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				result = fmt.Sprintf("%d %s", resp.StatusCode, body)
			}
			if result != c.Result {
				t.Errorf("result %q want %q", result, c.Result)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(hits) != len(c.Hits) {
				t.Fatalf("hits %d want %d", len(hits), len(c.Hits))
			}
			for i, w := range c.Hits {
				h := hits[i]
				if h.at != w.At || h.method != w.Method || fmt.Sprint(h.h) != fmt.Sprint(w.H) {
					t.Errorf("hit %d: %s %s %v\nwant %s %s %v", i, h.at, h.method, h.h, w.At, w.Method, w.H)
				}
			}
		})
	}
}
