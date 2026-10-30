package mcp

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// testdata/units.json：scripts/parity/record-mcp-units.mjs 用真 cross-spawn escape.js 与 eventsource-parser 3.1.1 生成。
type unitsFixture struct {
	Escape [][3]string `json:"escape"`
	SSE    []struct {
		Chunks []string            `json:"chunks"`
		Events []map[string]string `json:"events"`
	} `json:"sse"`
}

func loadUnits(t *testing.T) unitsFixture {
	b, err := os.ReadFile("testdata/units.json")
	if err != nil {
		t.Fatal(err)
	}
	var f unitsFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestEscapeArgumentGolden(t *testing.T) {
	for _, c := range loadUnits(t).Escape {
		if g := escapeArgument(c[0], false); g != c[1] {
			t.Errorf("escapeArgument(%q,false)=%q want %q", c[0], g, c[1])
		}
		if g := escapeArgument(c[0], true); g != c[2] {
			t.Errorf("escapeArgument(%q,true)=%q want %q", c[0], g, c[2])
		}
	}
}

func TestSSEParserGolden(t *testing.T) {
	for i, c := range loadUnits(t).SSE {
		got := []map[string]string{}
		p := newSSEParser(func(e sseEvent) {
			m := map[string]string{"data": e.Data}
			if e.HasID {
				m["id"] = e.ID
			}
			if e.HasEvent {
				m["event"] = e.Event
			}
			got = append(got, m)
		})
		for _, ch := range c.Chunks {
			p.feed(ch)
		}
		if !reflect.DeepEqual(got, c.Events) {
			t.Errorf("case %d: got %v want %v", i, got, c.Events)
		}
	}
}

func TestGetEnvironment(t *testing.T) {
	env := map[string]string{"PATH": "/bin", "HOME": "/h", "SECRET": "x", "FN": "() { :; }"}
	lookup := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	got := getEnvironment([][2]string{{"A", "1"}, {"HOME", "/o"}}, false, lookup)
	m := map[string]string{}
	for _, kv := range got {
		m[kv[0]] = kv[1]
	}
	if m["PATH"] != "/bin" || m["HOME"] != "/o" || m["A"] != "1" || m["SECRET"] != "" {
		t.Fatalf("getEnvironment = %v", got)
	}
}
