package usage

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sniffText(t *testing.T, u SniffedUsage) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(u); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func utf16Chunks(s string, n int) []string {
	var out []string
	for s != "" {
		c := util.UTF16Slice0(s, n)
		out = append(out, c)
		s = s[len(c):]
	}
	return out
}

func TestSniffParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/usage-sniff.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Objs   []json.RawMessage `json:"objs"`
		Frags  []json.RawMessage `json:"frags"`
		Merges []string          `json:"merges"`
		Taps   []struct {
			Chunks []string `json:"chunks"`
			Text   string   `json:"text"`
			Rep    string   `json:"rep"`
			Tail   string   `json:"tail"`
			N      int      `json:"n"`
			R      string   `json:"r"`
			Has    bool     `json:"has"`
		} `json:"taps"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for i, o := range g.Objs {
		v, err := util.ParseString(string(o))
		if err != nil {
			t.Fatal(err)
		}
		got := UsageFromObject(v)
		var want any
		_ = json.Unmarshal(g.Frags[i], &want)
		var gotV any = "__null__"
		if got != nil {
			gotV = normJSON(t, got)
		}
		if !deepEq(gotV, want) {
			t.Errorf("frag %d: got %v want %v", i, gotV, want)
		}
	}
	// merges：与录制脚本同一输入
	m1 := MergeUsage(EmptySniffed(), &PartialSniffed{Input: 3, CacheWrite: 10, CacheWrite1h: f64p(20), Model: strp("a"), ID: strp("x")})
	m2 := MergeUsage(SniffedUsage{Input: 5, Output: 1, CacheRead: 2, CacheWrite: 10, Model: strp("a"), ID: strp("first"), CacheWrite1h: f64p(4)},
		&PartialSniffed{Output: 9, CacheRead: 3, Model: strp(""), ID: strp("second"), Fast: boolp(true)})
	m3 := MergeUsage(SniffedUsage{Model: strp("")}, &PartialSniffed{Input: 1})
	m4 := MergeUsage(SniffedUsage{Fast: boolp(true)}, &PartialSniffed{Model: strp("b")})
	for i, m := range []SniffedUsage{m1, m2, m3, m4} {
		if s := sniffText(t, m); s != g.Merges[i] {
			t.Errorf("merge %d: %s != %s", i, s, g.Merges[i])
		}
	}
	for i, tp := range g.Taps {
		chunks := tp.Chunks
		switch {
		case tp.Text != "":
			chunks = utf16Chunks(tp.Text, tp.N)
		case tp.Rep != "":
			chunks = []string{strings.Repeat(tp.Rep, tp.N), tp.Tail}
		}
		tap := NewSseUsageTap()
		for _, c := range chunks {
			tap.Push(c)
		}
		r := tap.End()
		if s := sniffText(t, r); s != tp.R || HasTokens(r) != tp.Has {
			t.Errorf("tap %d: %s (%v) != %s (%v)", i, s, HasTokens(r), tp.R, tp.Has)
		}
	}
}
