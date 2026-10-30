package builtin

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type plug struct{ m, r, g *util.Obj }

var plugs = map[string]plug{
	"claude": {claude.Manifest, claude.Renderer, claude.Gateway},
	"codex":  {codex.Manifest, codex.Renderer, codex.Gateway},
	"dsh":    {dsh.Manifest, dsh.Renderer, dsh.Gateway},
	"gemini": {gemini.Manifest, gemini.Renderer, gemini.Gateway},
	"grok":   {grok.Manifest, grok.Renderer, grok.Gateway},
}

func eq(t *testing.T, what string, want, got any) {
	t.Helper()
	if w, g := util.Stringify(want), util.Stringify(got); w != g {
		t.Errorf("%s:\n want %s\n  got %s", what, w, g)
	}
}

func TestPluginsParity(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s2-plugins.json", filepath.Join("testdata", "b7s2-plugins.json"))
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	d := v.(*util.Obj)
	ids := []any{}
	for _, id := range IDs {
		ids = append(ids, id)
	}
	eq(t, "ids", d.Get("ids"), ids)
	eq(t, "manifests", d.Get("manifests"), Manifests)
	eq(t, "renderers", d.Get("renderers"), Renderers)
	eq(t, "gatewayEntries", d.Get("gatewayEntries"), GatewayEntries)
	eq(t, "defaultSessionKey", d.Get("defaultSessionKey"), sh.DefaultSessionKey)
	per := d.Get("per").(*util.Obj)
	if len(per.Keys()) != len(plugs) {
		t.Fatalf("plugins: want %v", per.Keys())
	}
	for _, id := range per.Keys() {
		w := per.Get(id).(*util.Obj)
		pl, ok := plugs[id]
		if !ok {
			t.Fatalf("missing plugin %s", id)
		}
		eq(t, id+".manifest", w.Get("manifest"), pl.m)
		eq(t, id+".renderer", w.Get("renderer"), pl.r)
		eq(t, id+".gateway", w.Get("gateway"), pl.g)
		idx := -1.0
		for i, g := range GatewayEntries {
			if g == pl.g {
				idx = float64(i)
			}
		}
		got := util.NewObj(
			"sameManifest", Manifests.Get(id) == pl.m,
			"sameRenderer", Renderers.Get(id) == pl.r,
			"capsShared", pl.r.Get("capabilities") == pl.m.Get("capabilities"),
			"sessionKeyShared", sameSlice(pl.g.Get("clientSpec").(*util.Obj).Get("sessionKey"), sh.DefaultSessionKey),
			"gatewayIndex", idx,
		)
		want := util.NewObj()
		for _, k := range got.Keys() {
			want.Set(k, w.Get(k))
		}
		eq(t, id+".refs", want, got)
		if Plugins[id].Manifest != pl.m {
			t.Errorf("%s: Plugins manifest not shared", id)
		}
	}
	for i, f := range d.Get("fns").([]any) {
		c := f.(*util.Obj)
		args := c.Get("args").([]any)
		var got any
		switch c.Get("fn") {
		case "rendererInfo":
			got = sh.RendererInfo(args[0].(*util.Obj))
		case "usageDone":
			got = sh.UsageDone.Completes(clisdk.Ev(args[0].(*util.Obj)))
		case "cleanTitle":
			s, _ := args[0].(string)
			max := 80
			if len(args) > 1 {
				max = int(args[1].(float64))
			}
			got = "<undefined>"
			if r := sh.CleanTitle(s, max); r != nil {
				got = *r
			}
		default:
			t.Fatalf("unknown fn %v", c.Get("fn"))
		}
		eq(t, util.Str(c.Get("fn"))+"#"+util.Stringify(float64(i)), c.Get("out"), got)
	}
	ib := []any{}
	for _, x := range []any{"claude", "grok", "x", "", nil, 1.0} {
		ib = append(ib, IsBuiltinCliID(x))
	}
	eq(t, "isBuiltin", d.Get("isBuiltin"), ib)
}

func sameSlice(a any, b []any) bool {
	x, ok := a.([]any)
	return ok && len(x) == len(b) && len(b) > 0 && &x[0] == &b[0]
}
