package usage

import (
	"encoding/json"
	"os"
	"testing"

	_ "time/tzdata"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type lpCase struct {
	Fn     string            `json:"fn"`
	Chunks []string          `json:"chunks"`
	Init   map[string]any    `json:"init"`
	Fb     []string          `json:"fb"`
	Row    json.RawMessage   `json:"row"`
	Out    []json.RawMessage `json:"out"`
	State  json.RawMessage   `json:"state"`
}

func rawAny(t *testing.T, b json.RawMessage) any {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if s, ok := v.(string); ok && s == "__undef__" {
		return "__undef__"
	}
	return v
}

func TestUsageLogParsersParity(t *testing.T) {
	path, _ := paritytest.Golden(t, "usage-logparsers.json", "testdata/usage-logparsers.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []lpCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	withTZ(t, "America/New_York")
	pass := 0
	for i, c := range g.Cases {
		var got []any
		var state ParseState
		switch c.Fn {
		case "codex", "dsh", "grok", "kimi":
			state = ParseState{}
			for k, v := range c.Init {
				state[k] = v
			}
			f := map[string]func(string, ParseState) []UsageRecord{"codex": ParseCodexChunk, "dsh": ParseDshChunk, "grok": ParseGrokChunk, "kimi": ParseKimiChunk}[c.Fn]
			for _, ch := range c.Chunks {
				got = append(got, normJSON(t, f(ch, state)))
			}
		case "claude", "aider", "qwen":
			f := map[string]func(string) []UsageRecord{"claude": ParseClaudeChunk, "aider": ParseAiderChunk, "qwen": ParseQwenChunk}[c.Fn]
			for _, ch := range c.Chunks {
				got = append(got, normJSON(t, f(ch)))
			}
		case "rateLimits":
			for _, ch := range c.Chunks {
				got = append(got, normJSON(t, ParseCodexRateLimits(ch)))
			}
		case "gemini":
			var cwd, sess *string
			if len(c.Fb) == 2 {
				cwd, sess = &c.Fb[0], &c.Fb[1]
			}
			got = append(got, normJSON(t, ParseGeminiFile(c.Chunks[0], cwd, sess)))
		case "opencode", "copilot":
			v, err := util.Parse(c.Row)
			if err != nil {
				t.Fatal(err)
			}
			if c.Fn == "opencode" {
				got = append(got, normJSON(t, OpencodeRowToRecord(v.(*util.Obj))))
			} else {
				got = append(got, normJSON(t, CopilotRowToRecord(v.(*util.Obj))))
			}
		case "LOG_SOURCES":
			got = append(got, normJSON(t, LogSources))
		default:
			t.Fatalf("unknown fn %s", c.Fn)
		}
		ok := len(got) == len(c.Out)
		for j := 0; ok && j < len(got); j++ {
			ok = deepEq(got[j], rawAny(t, c.Out[j]))
		}
		if ok && state != nil {
			ok = deepEq(normJSON(t, state), rawAny(t, c.State))
		}
		if !ok {
			gb, _ := json.Marshal(got)
			sb, _ := json.Marshal(state)
			t.Errorf("case %d %s mismatch\n got %s\nwant %s\n state %s\n want %s", i, c.Fn, gb, c.Out, sb, c.State)
			continue
		}
		pass++
	}
	t.Logf("logParsers parity %d/%d", pass, len(g.Cases))
}
