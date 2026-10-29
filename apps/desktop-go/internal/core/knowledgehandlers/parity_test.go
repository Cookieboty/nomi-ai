package knowledgehandlers

// 批次 8 golden：scripts/parity/record-b8.mjs（Node，TZ=Asia/Shanghai）录制，Go 逐项回放比对。

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

type pcase struct {
	Fn   string            `json:"fn"`
	Args []json.RawMessage `json:"args"`
	Out  json.RawMessage   `json:"out"`
}

func arg[T any](t *testing.T, raw json.RawMessage) T {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("arg %s: %v", raw, err)
	}
	return v
}

func TestParityB8(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("tzdata missing")
	}
	old := time.Local
	time.Local = loc
	defer func() { time.Local = old }()

	b, err := os.ReadFile("testdata/parity-b8.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []pcase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	llms := map[string]local.LocalLlm{}
	for _, m := range local.LocalLlms {
		llms[m.ID] = m
	}
	pass := 0
	for i, c := range cases {
		a := c.Args
		var got any
		switch c.Fn {
		case "describeRepeat":
			r := arg[schedule.Repeat](t, a[0])
			got = schedule.DescribeRepeat(&r)
		case "nextOccurrence":
			got = schedule.NextOccurrence(arg[schedule.Repeat](t, a[0]), arg[int64](t, a[1]), arg[int64](t, a[2]))
		case "firstRun":
			got = schedule.FirstRun(arg[string](t, a[0]), arg[schedule.Repeat](t, a[1]), arg[int64](t, a[2]))
		case "sanitizeRepeat":
			got = schedule.SanitizeRepeat(arg[any](t, a[0]))
		case "inQuiet":
			got = schedule.InQuiet(arg[schedule.QuietHours](t, a[0]), arg[int64](t, a[1]))
		case "quietEndsAt":
			got = schedule.QuietEndsAt(arg[schedule.QuietHours](t, a[0]), arg[int64](t, a[1]))
		case "chunkText":
			got = knowledge.ChunkText(arg[string](t, a[0]), arg[int](t, a[1]), arg[int](t, a[2]), arg[int](t, a[3]))
		case "chunkPages":
			got = knowledge.ChunkPages(arg[[]string](t, a[0]), 800, 120)
		case "tokenize":
			got = knowledge.Tokenize(arg[string](t, a[0]))
		case "citedNumbers":
			got = knowledge.CitedNumbers(arg[string](t, a[0]), arg[int](t, a[1]))
		case "slugId":
			tk := map[string]bool{}
			for _, s := range arg[[]string](t, a[1]) {
				tk[s] = true
			}
			got = extensions.SlugID(arg[string](t, a[0]), tk)
		case "isSecretValue":
			got = extensions.IsSecretValue(arg[string](t, a[0]))
		case "stripUrlCredentials":
			got = extensions.StripURLCredentials(arg[string](t, a[0]))
		case "nomiSkillName":
			got = extensions.NomiSkillName(arg[string](t, a[0]))
		case "validSkillName":
			got = extensions.ValidSkillName(arg[string](t, a[0]))
		case "normFact":
			got = memory.NormFact(arg[string](t, a[0]))
		case "isDuplicateFact":
			got = memory.IsDuplicateFact(arg[string](t, a[0]), arg[string](t, a[1]))
		case "parseSummary":
			got = memory.ParseSummary(arg[string](t, a[0]))
		case "recommend":
			got = local.Recommend(arg[float64](t, a[0]), nil).ID
		case "fitLevel":
			got = local.FitLevel(llms[arg[string](t, a[0])], arg[float64](t, a[1]))
		case "serverArgs":
			got = local.ServerArgs(arg[string](t, a[0]), arg[int](t, a[1]), arg[int](t, a[2]), arg[int](t, a[3]))
		default:
			t.Fatalf("unknown fn %s", c.Fn)
		}
		gb, _ := json.Marshal(got)
		var g, w any
		_ = json.Unmarshal(gb, &g)
		_ = json.Unmarshal(c.Out, &w)
		if !reflect.DeepEqual(norm(g), norm(w)) {
			t.Errorf("#%d %s%s\n got  %s\n want %s", i, c.Fn, a, gb, c.Out)
			continue
		}
		pass++
	}
	t.Logf("parity-b8: %d/%d", pass, len(cases))
}

// norm：Node 的空数组与 Go 的 nil 切片在 JSON 里分别是 [] / null，统一为 []。
func norm(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []any:
		for i := range x {
			x[i] = norm(x[i])
		}
		return x
	case map[string]any:
		for k, e := range x {
			x[k] = norm(e)
		}
		return x
	}
	return v
}
