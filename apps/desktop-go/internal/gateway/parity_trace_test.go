package gateway_test

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func strList(v any) []string {
	out := []string{}
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func parseJS(t *testing.T, s string) any {
	v, err := u.ParseString(s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestParityTrace(t *testing.T) {
	fx := loadJSFixture(t, "trace")
	tl := tally{}
	var sets [][]string
	for _, s := range fx.Get("secretsSets").([]any) {
		sets = append(sets, strList(s))
	}
	for i, r := range fx.Get("redact").([]any) {
		a := r.([]any)
		check(t, tl, "redactText", server.RedactText(a[0].(string), sets[int(a[1].(float64))]), a[2], i)
	}
	for i, r := range fx.Get("json").([]any) {
		a := r.([]any)
		got := u.Stringify(server.RedactJSON(parseJS(t, a[0].(string)), sets[int(a[1].(float64))]))
		check(t, tl, "redactJson", got, a[2], i)
	}
	for i, r := range fx.Get("headers").([]any) {
		a := r.([]any)
		check(t, tl, "redactHeaders", server.RedactHeaders(a[0].(*u.Obj), sets[1]), a[1], i)
	}
	for i, r := range fx.Get("diff").([]any) {
		a := r.([]any)
		var got any
		if d := server.TraceDiff(a[0].(string), a[1].(string)); d != nil {
			got = d.Obj()
		}
		check(t, tl, "traceDiff", got, a[2], i)
	}
	for i, r := range fx.Get("stamps").([]any) {
		a := r.([]any)
		check(t, tl, "traceStamp", server.TraceStamp(a[0].(float64)), a[1], i)
	}
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(fx.Get("cfg"))), &cfg); err != nil {
		t.Fatal(err)
	}
	check(t, tl, "secretsOf", server.SecretsOf(&cfg), fx.Get("secretsOf"))
	for i, x := range fx.Get("files").([]any) {
		o := x.(*u.Obj)
		m := o.Get("meta").(*u.Obj)
		dir := filepath.Join(t.TempDir(), "traces")
		tr := server.NewRequestTrace(dir, &cfg, server.TraceMeta{Client: m.Get("client").(string), Ingress: m.Get("ingress").(string), Path: m.Get("path").(string), StartedAt: m.Get("startedAt").(float64)},
			server.TraceOpts{ID: o.Get("id").(string), Now: func() float64 { return 0 }})
		var file string
		for _, op := range o.Get("ops").([]any) {
			a := op.([]any)
			switch a[0].(string) {
			case "addSecrets":
				tr.AddSecrets(strList(a[1]))
			case "request":
				var body any
				if a[3].(bool) {
					body = parseJS(t, a[2].(string))
				}
				tr.Request(a[1].(*u.Obj), body, a[3].(bool))
			case "attempt":
				tr.Attempt(parseJS(t, a[1].(string)).(*u.Obj))
			case "attemptResult":
				tr.AttemptResult(int(a[1].(float64)), a[2].(string))
			case "response":
				tr.Response(int(a[1].(float64)), a[2].(string))
			case "client":
				tr.Client(a[1].(string))
			case "finish":
				var err error
				if file, err = tr.Finish(parseJS(t, a[1].(string)).(*u.Obj)); err != nil {
					t.Fatal(err)
				}
			}
		}
		rel, _ := filepath.Rel(dir, file)
		check(t, tl, "trace.name", rel, o.Get("name"), i)
		ents, _ := os.ReadDir(dir)
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		check(t, tl, "trace.names", names, o.Get("names"), i)
		b, _ := os.ReadFile(file)
		check(t, tl, "trace.content", string(b), o.Get("content"), i)
		if st, err := os.Stat(file); err == nil && st.Mode().Perm() != 0o600 && os.PathSeparator == '/' {
			t.Errorf("trace mode %v", st.Mode())
		}
	}
	bad := server.NewRequestTrace(t.TempDir(), &cfg, server.TraceMeta{StartedAt: math.NaN()}, server.TraceOpts{})
	if _, err := bad.Finish(u.NewObj()); err == nil || err.Error() != "Invalid time value" {
		t.Errorf("finish NaN: %v", err)
	}
	tl.report(t, "trace")
}
