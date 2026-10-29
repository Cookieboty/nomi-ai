package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage/quality"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type gwreqScen struct {
	Name  string  `json:"name"`
	Files [][]any `json:"files"`
	Opts  struct {
		TraceOn      bool `json:"traceOn"`
		NoImport     bool `json:"noImport"`
		ImportThrows bool `json:"importThrows"`
	} `json:"opts"`
	Imported     string   `json:"imported"`
	Warns        int      `json:"warns"`
	RequestsLeft bool     `json:"requestsLeft"`
	TraceDir     *string  `json:"traceDir"`
	Remaining    []string `json:"remaining"`
	LegacyTrace  bool     `json:"legacyTrace"`
	TraceDir2    *string  `json:"traceDir2"`
	Prune2       int      `json:"prune2"`
}

type gwWarnLog struct{ n *int }

func (gwWarnLog) Info(string, any)   {}
func (l gwWarnLog) Warn(string, any) { *l.n++ }

func TestGatewayRequestsParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/usage-gwreq.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		ToEntryCases  [][3]string `json:"toEntryCases"`
		Entries       []string    `json:"entries"`
		SanitizeCases []string    `json:"sanitizeCases"`
		Sanitized     []string    `json:"sanitized"`
		Errs          []string    `json:"errs"`
		Cleaned       []string    `json:"cleaned"`
		LegacyIn      []string    `json:"legacyIn"`
		LegacyOut     []string    `json:"legacyOut"`
		Now           float64     `json:"now"`
		Scen          []gwreqScen `json:"scen"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	parse := func(s string) any {
		if s == "__undef__" {
			return nil
		}
		v, err := util.ParseString(s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	stringifyEntries := func(es []*GatewayRequestEntry) string {
		arr := make([]any, len(es))
		for i, e := range es {
			arr[i] = e.Obj()
		}
		return util.Stringify(arr)
	}
	for i, c := range g.ToEntryCases {
		ev, _ := parse(c[0]).(*util.Obj)
		var p, k any
		if n, ok := parse(c[2]).(*util.Obj); ok {
			p, k = n.Get("provider"), n.Get("key")
		}
		if got := util.Stringify(ToEntry(ev, c[1], p, k).Obj()); got != g.Entries[i] {
			t.Errorf("toEntry %d:\n got %s\nwant %s", i, got, g.Entries[i])
		}
	}
	for i, c := range g.SanitizeCases {
		if got := stringifyEntries(SanitizeEntries(parse(c))); got != g.Sanitized[i] {
			t.Errorf("sanitize %d:\n got %s\nwant %s", i, got, g.Sanitized[i])
		}
	}
	for i, e := range g.Errs {
		in := e
		if in == "__undef__" {
			in = ""
		}
		got := CleanError(in)
		want := g.Cleaned[i]
		if want == "__undef__" {
			want = ""
		}
		if got != want {
			t.Errorf("cleanError %d %q: got %q want %q", i, e, got, want)
		}
	}
	for i, c := range g.LegacyIn {
		es := SanitizeEntries([]any{parse(c)})
		arr := []any{}
		for _, e := range es {
			arr = append(arr, quality.RecordFromEntry(e.Legacy()))
		}
		if got := util.Stringify(arr); got != g.LegacyOut[i] {
			t.Errorf("legacy %d:\n got %s\nwant %s", i, got, g.LegacyOut[i])
		}
	}
	for _, s := range g.Scen {
		t.Run(s.Name, func(t *testing.T) {
			dir := t.TempDir()
			for _, f := range s.Files {
				p := filepath.Join(dir, f[0].(string))
				_ = os.MkdirAll(filepath.Dir(p), 0o755)
				if f[1].(string) == "__dir__" {
					_ = os.MkdirAll(p, 0o755)
				} else if err := os.WriteFile(p, []byte(f[1].(string)), 0o644); err != nil {
					t.Fatal(err)
				}
				if len(f) > 2 {
					ts := time.UnixMilli(int64(g.Now - f[2].(float64)))
					_ = os.Chtimes(p, ts, ts)
				}
			}
			warns := 0
			imported := []any{}
			traceOn := s.Opts.TraceOn
			zero := 0.0
			d := GatewayRequestLogDeps{Root: dir, Logger: gwWarnLog{&warns}, TraceOn: func() bool { return traceOn },
				Now: func() float64 { return g.Now }, PruneMs: &zero}
			if !s.Opts.NoImport {
				throws := s.Opts.ImportThrows
				d.ImportLegacy = func(recs []*util.Obj) error {
					if throws {
						return os.ErrInvalid
					}
					for _, r := range recs {
						imported = append(imported, r)
					}
					return nil
				}
			}
			l := NewGatewayRequestLog(d)
			if got := util.Stringify(imported); got != s.Imported {
				t.Errorf("imported:\n got %s\nwant %s", got, s.Imported)
			}
			if warns != s.Warns {
				t.Errorf("warns %d want %d", warns, s.Warns)
			}
			if _, err := os.Stat(filepath.Join(dir, "requests.json")); (err == nil) != s.RequestsLeft {
				t.Errorf("requestsLeft want %v", s.RequestsLeft)
			}
			td := func() *string {
				v := l.TraceDir()
				if v == "" {
					return nil
				}
				r := filepath.ToSlash(v[len(dir):])
				return &r
			}
			eq := func(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
			if !eq(td(), s.TraceDir) {
				t.Errorf("traceDir %v want %v", td(), s.TraceDir)
			}
			var rem []string
			if ents, err := os.ReadDir(filepath.Join(dir, "trace")); err == nil {
				rem = []string{}
				for _, e := range ents {
					rem = append(rem, e.Name())
				}
				sort.Strings(rem)
			}
			if (rem == nil) != (s.Remaining == nil) || util.Stringify(toAnySlice(rem)) != util.Stringify(toAnySlice(s.Remaining)) {
				t.Errorf("remaining %v want %v", rem, s.Remaining)
			}
			if ReadLegacyGatewayTrace(dir) != s.LegacyTrace {
				t.Errorf("legacyTrace want %v", s.LegacyTrace)
			}
			traceOn = !traceOn
			if !eq(td(), s.TraceDir2) {
				t.Errorf("traceDir2 %v want %v", td(), s.TraceDir2)
			}
			if n := l.Prune(); n != s.Prune2 {
				t.Errorf("prune2 %d want %d", n, s.Prune2)
			}
			l.Dispose()
		})
	}
}

func toAnySlice(s []string) []any {
	r := make([]any, len(s))
	for i, v := range s {
		r[i] = v
	}
	return r
}
