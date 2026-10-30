// Golden parity replay: fixtures are recorded from the Node gateway by
// scripts/parity/record.mjs; this test feeds the same inputs to the Go port and
// diffs normalised outputs. Run `go test ./internal/gateway -run Parity -v` to
// see per-protocol pass/fail counts.
package gateway_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/request"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// normalize masks values that are random or wall-clock on both sides.
var (
	ridRe     = regexp.MustCompile(`\b([a-z]+)_nomi_[0-9a-z]+`)
	createdRe = regexp.MustCompile(`"(created|created_at)":\d+`)
)

func normalize(s string) string {
	s = ridRe.ReplaceAllString(s, "${1}_nomi_<rid>")
	return createdRe.ReplaceAllString(s, `"$1":<ts>`)
}

func loadFixture(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "parity", name+".json"))
	if err != nil {
		t.Fatalf("read fixture %s: %v (run node scripts/parity/record.mjs)", name, err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
}

type tally map[string][2]int // key → {pass, fail}

func (t tally) add(k string, ok bool) {
	v := t[k]
	if ok {
		v[0]++
	} else {
		v[1]++
	}
	t[k] = v
}

func (t tally) report(tb testing.TB, section string) {
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "  %-12s pass=%d fail=%d\n", k, t[k][0], t[k][1])
	}
	tb.Logf("parity %s:\n%s", section, b.String())
	for _, k := range keys {
		if t[k][1] > 0 {
			tb.Errorf("parity %s/%s: %d mismatches", section, k, t[k][1])
		}
	}
}

func firstDiff(a, b string) string {
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	lo := i - 60
	if lo < 0 {
		lo = 0
	}
	clip := func(s string) string {
		hi := i + 80
		if hi > len(s) {
			hi = len(s)
		}
		if lo > len(s) {
			return ""
		}
		return s[lo:hi]
	}
	return fmt.Sprintf("at byte %d\n  node: …%s…\n  go:   …%s…", i, clip(a), clip(b))
}

func TestParityRequest(t *testing.T) {
	var fx struct {
		Cases []struct {
			Name, From, To, Input, Seed, Output string
			Opts                                struct {
				UpstreamModel     *string `json:"upstreamModel"`
				ReasoningPassback bool    `json:"reasoningPassback"`
				Model             *string `json:"model"`
				Stream            bool    `json:"stream"`
			}
		}
	}
	loadFixture(t, "request", &fx)
	tl := tally{}
	for _, c := range fx.Cases {
		body, err := u.ParseString(c.Input)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		got := u.Stringify(request.ConvertRequest(c.From, c.To, body, request.ConvertOptions{
			DecodeOptions: request.DecodeOptions{Model: c.Opts.Model, Stream: c.Opts.Stream},
			EncodeOptions: request.EncodeOptions{ReasoningPassback: c.Opts.ReasoningPassback},
			UpstreamModel: c.Opts.UpstreamModel,
		}))
		ok := got == c.Output
		if !ok {
			t.Errorf("%s: output differs %s", c.Name, firstDiff(c.Output, got))
		}
		seed := response.CallIDSeed(body)
		if seed != c.Seed {
			ok = false
			t.Errorf("%s: callIdSeed node=%s go=%s", c.Name, c.Seed, seed)
		}
		tl.add(c.From+"→*", ok)
	}
	tl.report(t, "request")
}
