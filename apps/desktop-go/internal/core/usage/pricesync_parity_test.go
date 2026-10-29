package usage

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
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
	Warns int   `json:"warns"`
	Datas []int `json:"datas"`
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
			warns, i := 0, 0
			datas := []int{}
			type seenT struct {
				url, method string
				h           http.Header
			}
			var seen []seenT
			ps := NewPriceSync(PriceSyncDeps{
				Root: dir, Now: func() float64 { return g.Now + float64(i)*1000 }, Logger: gwWarnLog{&warns},
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
			if warns != s.Warns || util.Stringify(intsAny(datas)) != util.Stringify(intsAny(s.Datas)) {
				t.Errorf("warns %d datas %v want %d %v", warns, datas, s.Warns, s.Datas)
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
