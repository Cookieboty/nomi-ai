package agents

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// sorted re-creates a value with keys in sorted order（与 recorder 的 sortKeys 同形）。
func sorted(v any) any {
	switch x := v.(type) {
	case *util.Obj:
		ks := x.Keys()
		sort.Strings(ks)
		o := util.NewObj()
		for _, k := range ks {
			o.Set(k, sorted(x.Get(k)))
		}
		return o
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = sorted(e)
		}
		return out
	}
	return v
}

func infoObj(i SessionInfo) *util.Obj {
	o := util.NewObj("phase", i.Phase)
	for k, v := range map[string]string{"sessionId": i.SessionID, "parentId": i.ParentID, "cwd": i.Cwd, "model": i.Model,
		"reasoningEffort": i.ReasoningEffort, "title": i.Title, "detail": i.Detail} {
		if v != "" {
			o.Set(k, v)
		}
	}
	if i.PermissionMode != nil {
		o.Set("permissionMode", *i.PermissionMode)
	}
	if i.LastAt != nil {
		o.Set("lastAt", *i.LastAt)
	}
	return o
}

func sArg(a []any, i int) string {
	if i < len(a) {
		if s, ok := a[i].(string); ok {
			return s
		}
	}
	return ""
}

var registry = map[string]func(a []any) any{
	"jsonlEvents": func(a []any) any {
		ev := JsonlEvents(sArg(a, 0), int(a[1].(float64)))
		out := make([]any, len(ev))
		for i, e := range ev {
			out[i] = e
		}
		return out
	},
	"parseClaudeSession": func(a []any) any { return infoObj(ParseClaudeSession(sArg(a, 0), sArg(a, 1))) },
	"parseCodexSession":  func(a []any) any { return infoObj(ParseCodexSession(sArg(a, 0), sArg(a, 1))) },
	"parseGrokSession":   func(a []any) any { return infoObj(ParseGrokSession(sArg(a, 0), sArg(a, 1))) },
	"parseGeminiSession": func(a []any) any { return infoObj(ParseGeminiSession(sArg(a, 0))) },
	"parseDshSession":    func(a []any) any { return infoObj(ParseDshSession(sArg(a, 0), sArg(a, 1))) },
	"decideStatus": func(a []any) any {
		o := a[0].(*util.Obj)
		in := StatusInput{Phase: o.Get("phase").(string), AgeMs: o.Get("ageMs").(float64), StallMs: o.Get("stallMs").(float64)}
		if b, ok := o.Get("alive").(bool); ok {
			in.Alive = &b
		}
		return DecideStatus(in)
	},
	"parseDshProjcache": func(a []any) any {
		r := ParseDshProjcache(sArg(a, 0))
		o := util.NewObj()
		if r.Cwd != nil {
			o.Set("cwd", *r.Cwd)
		}
		if r.Title != "" {
			o.Set("title", r.Title)
		}
		if r.PermissionMode != "" {
			o.Set("permissionMode", r.PermissionMode)
		}
		return o
	},
}

func run(fn func([]any) any, args []any) (out *util.Obj) {
	defer func() {
		if r := recover(); r != nil {
			te, ok := r.(*TypeError)
			if !ok {
				panic(r)
			}
			out = util.NewObj("err", te.Msg, "name", te.Name())
		}
	}()
	return util.NewObj("v", sorted(fn(args)))
}

// TestParsersGolden replays scripts/parity/record-b7s-agents.mjs（Node 录制）；任何不一致即失败。
func TestParsersGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s-parsers.json", filepath.Join("testdata", "b7s-parsers.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	g, err := util.ParseString(string(b))
	if err != nil {
		t.Fatal(err)
	}
	cases := g.(*util.Obj).Get("cases").([]any)
	if len(cases) < 150 {
		t.Fatalf("too few cases: %d", len(cases))
	}
	for i, c := range cases {
		co := c.(*util.Obj)
		name := co.Get("fn").(string)
		fn := registry[name]
		if fn == nil {
			t.Fatalf("unregistered fn %s", name)
		}
		args, _ := co.Get("args").([]any)
		want := util.Stringify(co.Get("out"))
		got := util.Stringify(run(fn, args))
		if got != want {
			t.Errorf("case %d %s(%s)\n got  %s\n want %s", i, name, util.Stringify(args), got, want)
		}
	}
	fmt.Fprintf(os.Stderr, "agents/parsers: %d cases\n", len(cases))
}
