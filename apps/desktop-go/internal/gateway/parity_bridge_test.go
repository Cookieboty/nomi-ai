package gateway_test

import (
	"regexp"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func checkN(t *testing.T, tl tally, name string, got, want any, ctx ...any) {
	t.Helper()
	g, w := normEsc(u.Stringify(got)), normEsc(u.Stringify(want))
	if g != w {
		t.Logf("%s %v:\n %s", name, ctx, firstDiff(g, w))
	}
	tl.add(name, g == w)
}

var createdEsc = regexp.MustCompile(`(\\?"(?:created|created_at)\\?":)\d+`)

// normEsc is normalize() that also sees JSON-escaped SSE text.
func normEsc(s string) string { return createdEsc.ReplaceAllString(normalize(s), "${1}<ts>") }

func notesOf(n *[]string) []any {
	out := []any{}
	for _, s := range *n {
		out = append(out, s)
	}
	return out
}

func TestParityBridge(t *testing.T) {
	fx := loadJSFixture(t, "bridge")
	tl := tally{}
	check(t, tl, "truncated", server.TruncatedMessage, fx.Get("truncated"))
	ct := map[string]bool{"apply_patch": true}
	for _, x := range fx.Get("cases").([]any) {
		c := x.(*u.Obj)
		name := c.Get("name").(string)
		from, to := c.Get("from").(string), c.Get("to").(string)
		fixes, notes := fixOpts(c.Get("variant").(string))
		plan := server.BridgePlan{From: from, To: to, Mode: server.BridgeModeOf(from, to, c.Get("needs").(bool)), Model: "fallback", CustomTools: ct, Fixes: fixes, Heartbeat: c.Get("heartbeat").(string)}
		b := server.CreateBridge(plan)
		check(t, tl, "bridge.mode", b.Mode(), c.Get("mode"), name)
		for k, op := range c.Get("ops").([]any) {
			a := op.([]any)
			var got string
			switch a[0].(string) {
			case "alive":
				got = b.Alive()
				checkN(t, tl, "bridge.alive", got, a[1], name, k)
				continue
			case "push":
				got = b.Push(a[1].(string))
			case "fail":
				got = b.Fail(a[1].(string))
			case "end":
				got = b.End(a[1].(string))
			}
			checkN(t, tl, "bridge."+a[0].(string), got, a[2], name, k)
		}
		check(t, tl, "bridge.stopped", b.Stopped(), c.Get("stopped"), name)
		check(t, tl, "bridge.notes", notesOf(notes), c.Get("notes"), name)
	}
	for i, x := range fx.Get("json").([]any) {
		c := x.(*u.Obj)
		from, to := c.Get("from").(string), c.Get("to").(string)
		fixes, notes := fixOpts(c.Get("variant").(string))
		plan := server.BridgePlan{From: from, To: to, Mode: server.BridgeModeOf(from, to, c.Get("needs").(bool)), Model: "fallback", CustomTools: ct, Fixes: fixes}
		text := c.Get("text").(string)
		var parsed any
		if c.Get("parsed").(bool) {
			parsed = parseJS(t, text)
		}
		up := server.UpstreamJSON{Status: int(c.Get("upStatus").(float64)), Text: text, Parsed: parsed}
		r := c.Get("out").(*u.Obj)
		if s, ok := c.Get("ct").(string); ok {
			up.ContentType = &s
		}
		o := server.BridgeJSON(plan, up, c.Get("wantsStream").(bool))
		var got *u.Obj
		switch o.Kind {
		case "sse":
			got = u.NewObj("kind", "sse", "body", o.Body)
		case "raw":
			got = u.NewObj("kind", "raw", "status", float64(o.Status), "contentType", o.ContentType, "body", o.Body)
		default:
			got = u.NewObj("kind", "json", "status", float64(o.Status), "body", u.Stringify(o.JSON))
		}
		checkN(t, tl, "bridgeJson."+o.Kind, got, r, i)
		check(t, tl, "bridgeJson.notes", notesOf(notes), c.Get("notes"), i)
	}
	tl.report(t, "bridge")
}
