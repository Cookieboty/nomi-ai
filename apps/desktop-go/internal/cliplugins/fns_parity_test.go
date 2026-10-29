package cliplugins_test

import (
	"os"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var undef = util.NewObj("$undef", true)

func isUndefArg(v any) bool {
	o, ok := v.(*util.Obj)
	return ok && o.Len() == 1 && o.Get("$undef") == true
}

func strPtrOut(p *string) any {
	if p == nil {
		return undef
	}
	return *p
}

func jsonsAny(l []sh.Json) any {
	out := make([]any, len(l))
	for i, x := range l {
		out[i] = x
	}
	return out
}

func arg(args []any, i int) any {
	if i >= len(args) || isUndefArg(args[i]) {
		return nil
	}
	return args[i]
}

func fallback(args []any) float64 {
	if f, ok := arg(args, 1).(float64); ok {
		return f
	}
	return 0
}

func transcript(p func(string, float64) []sh.Json) func([]any) any {
	return func(a []any) any { return jsonsAny(p(a[0].(string), fallback(a))) }
}

var fnRegistry = map[string]func(args []any) any{
	"parseClaudeTranscript": transcript(claude.ParseTranscript),
	"parseCodexTranscript":  transcript(codex.ParseTranscript),
	"parseDshTranscript":    transcript(dsh.ParseTranscript),
	"parseGeminiTranscript": transcript(gemini.ParseTranscript),
	"parseGrokTranscript":   transcript(grok.ParseTranscript),
	"parseClaudeModels": func(a []any) any {
		return claude.ParseModels(arg(a, 0), sh.AsObj(arg(a, 1)).Get("effort"))
	},
	"parseCodexModels": func(a []any) any {
		c := sh.AsObj(arg(a, 1))
		return codex.ParseModels(arg(a, 0), c.Get("model"), c.Get("effort"))
	},
	"parseGrokModels": func(a []any) any { return grok.ParseModels(arg(a, 0)) },
	"readClaudeEffortSetting": func(a []any) any {
		if s, ok := claude.ReadEffortSetting(a[0].(string)); ok {
			return s
		}
		return nil
	},
	"readCodexConfigDefaults": func(a []any) any {
		m, e := codex.ReadConfigDefaults(a[0].(string))
		o := util.NewObj("model", nil, "effort", nil)
		if m != "" {
			o.Set("model", m)
		}
		if e != "" {
			o.Set("effort", e)
		}
		return o
	},
	"titleFromMessages": func(a []any) any {
		l, _ := a[0].([]any)
		ms := make([]sh.Json, len(l))
		for i, x := range l {
			ms[i] = sh.AsObj(x)
		}
		return strPtrOut(sh.TitleFromMessages(ms))
	},
	"cleanTitle": func(a []any) any {
		s, _ := arg(a, 0).(string)
		max := 80
		if f, ok := arg(a, 1).(float64); ok {
			max = int(f)
		}
		return strPtrOut(sh.CleanTitle(s, max))
	},
}

// TestFnParity 回放 scripts/parity/record-b7-fns.mjs 录下的 Node 纯函数输出，逐字节比对 JSON。
func TestFnParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/fns.json")
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.ParseString(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for i, c := range v.([]any) {
		co := c.(*util.Obj)
		fn := co.Get("fn").(string)
		run := fnRegistry[fn]
		if run == nil {
			t.Fatalf("case %d: no Go impl for %s", i, fn)
		}
		args, _ := co.Get("args").([]any)
		want := util.Stringify(co.Get("out"))
		got := util.Stringify(run(args))
		if got != want {
			t.Errorf("case %d %s(%.200s)\n got  %.600s\n want %.600s", i, fn, util.Stringify(args), got, want)
		}
		n++
	}
	t.Logf("%d function cases matched", n)
}
