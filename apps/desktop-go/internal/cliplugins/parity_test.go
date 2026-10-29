package cliplugins_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// TestStreamParity 回放 scripts/parity/record-b7.mjs 录下的 Node 解析输出，逐行逐字节比对。
func TestStreamParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/streams.json")
	if err != nil {
		t.Fatal(err)
	}
	var streams []struct {
		Fn      string            `json:"fn"`
		ID      string            `json:"id"`
		Lines   []string          `json:"lines"`
		Outputs []json.RawMessage `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &streams); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, s := range streams {
		var run func(string) []clisdk.Ev
		switch s.Fn {
		case "parseClaudeLine":
			run = func(l string) []clisdk.Ev { return claude.ParseLine(l, nil) }
		case "parseClaudeLine+state":
			st := &claude.StreamState{}
			run = func(l string) []clisdk.Ev { return claude.ParseLine(l, st) }
		case "createClaudeParser":
			run = claude.NewParser()
		case "parseCodexLine", "parseCodexLine+seq":
			run = codex.ParseLine
		case "parseGrokLine":
			run = grok.ParseLine
		case "createGrokParser":
			run = grok.NewParser()
		case "parseDshLine":
			run = dsh.ParseLine
		case "createDshParser":
			run = dsh.NewParser()
		default:
			t.Fatalf("unknown fn %s", s.Fn)
		}
		for i, l := range s.Lines {
			evs := run(l)
			arr := make([]any, len(evs))
			for k, e := range evs {
				arr[k] = e
			}
			want, _ := util.ParseString(string(s.Outputs[i]))
			if got, w := util.Stringify(arr), util.Stringify(want); got != w {
				t.Errorf("%s %s line %d %q\n got %s\nwant %s", s.Fn, s.ID, i, trunc(l), got, w)
			}
			n++
		}
	}
	if n < 200 {
		t.Fatalf("corpus too small: %d", n)
	}
	t.Logf("stream parity: %d streams, %d lines", len(streams), n)
}

func trunc(s string) string {
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return strings.TrimSpace(s)
}
