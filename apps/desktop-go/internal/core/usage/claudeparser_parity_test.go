package usage

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestClaudeParserParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/usage-claudeparser.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		TZ    string `json:"tz"`
		Reset []struct {
			S    string   `json:"s"`
			Now  *float64 `json:"now"`
			Span float64  `json:"span"`
			R    *float64 `json:"r"`
		} `json:"reset"`
		Outputs []string `json:"outputs"`
		Parsed  []string `json:"parsed"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	withTZ(t, g.TZ)
	bad := 0
	for _, c := range g.Reset {
		now := math.NaN()
		if c.Now != nil {
			now = *c.Now
		}
		got := ParseClaudeResetTime(c.S, now, c.Span)
		if (got == nil) != (c.R == nil) || (got != nil && *got != *c.R) {
			bad++
			if bad < 15 {
				t.Errorf("reset %q now=%v span=%v: got %v want %v", c.S, now, c.Span, fp(got), fp(c.R))
			}
		}
	}
	now := *g.Reset[0].Now
	for i, o := range g.Outputs {
		b, _ := json.Marshal(ParseClaudeUsageResult(o, now))
		if string(b) != g.Parsed[i] {
			t.Errorf("parse %d %q:\n got %s\nwant %s", i, o, b, g.Parsed[i])
		}
	}
}

func fp(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
