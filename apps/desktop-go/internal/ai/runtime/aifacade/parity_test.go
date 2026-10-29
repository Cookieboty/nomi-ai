package aifacade

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract/gen"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 金样：scripts/parity/record-b7s-aifacade.mjs（Node AIClient + bundle-ig-base 真实插件）
var sessRe = regexp.MustCompile(`sess_[0-9a-z]+_[0-9a-z]+`)

func scrub(s string) string {
	seen := map[string]string{}
	return sessRe.ReplaceAllStringFunc(s, func(id string) string {
		if v, ok := seen[id]; ok {
			return v
		}
		pre := id[:strings.LastIndex(id, "_")+1]
		v := pre + "#" + strconv.Itoa(len(seen)+1)
		seen[id] = v
		return v
	})
}

func mustParse(t *testing.T, path string) []any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	v, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v.([]any)
}

// RunScenario 重放一条场景（经 Router / Session 线上帧），返回与金样同形的步骤列表
func runScenario(t *testing.T, sc *u.Obj, gold []any) (got, want []any) {
	clock := 1700000000000.0
	now := func() float64 { return clock }
	dir := t.TempDir()
	pf := ProfilePath(dir)
	if f, ok := sc.Get("file").(string); ok && sc.Has("file") {
		_ = os.MkdirAll(filepath.Dir(pf), 0o755)
		_ = os.WriteFile(pf, []byte(f), 0o644)
	}
	var events []any
	emit := func(ev string, data any) {
		e := u.NewObj()
		e.Set("event", ev)
		e.Set("data", data)
		events = append(events, e)
	}
	o := Options{Now: now, Emit: emit, Avatar: sc.Get("avatar") != false}
	if sc.Get("host") != false {
		o.AvatarHost = func(c *u.Obj) { emit("avatar.event", c) }
	}
	if sc.Get("registry") != false {
		reg := tools.NewInMemory()
		if ts, ok := sc.Get("tools").([]any); ok {
			for _, x := range ts {
				d := x.(*u.Obj)
				def := tools.Definition{Name: d.Get("name").(string)}
				if s, ok := d.Get("description").(string); ok && d.Has("description") {
					def.Description = s
				} else {
					def.NoDescription = true
				}
				if b, ok := d.Get("dangerous").(bool); ok && d.Has("dangerous") {
					def.Dangerous = b
				} else {
					def.DangerousUnset = true
				}
				reg.Register(def)
			}
		}
		o.Tools = reg
	}
	if sc.Get("profile") != false {
		o.Profile = NewProfileStore(pf, now)
	}
	f := New(o)
	if o.Profile != nil {
		o.Profile.Export()
	}
	// 走真实 Router / Session（线上帧）：契约 kind / dangerous / surfaces 来自生成的过程表
	r := contract.NewRouter()
	f.Register(r)
	for _, p := range gen.Procedures {
		r.Declare(p.Name, p.Kind, p.Dangerous)
		if len(p.Surfaces) > 0 {
			r.Restrict(p.Name, p.Surfaces)
		}
	}
	frames := make(chan contract.ServerFrame, 4)
	send := func(fr contract.ServerFrame) { frames <- fr }
	trusted := r.NewSession(context.Background(), contract.Caller{Surface: "chat", ID: 1}, send)
	untrusted := r.NewSession(context.Background(), contract.Caller{Surface: "chat", ID: 2, Untrusted: true}, send)
	reqN := 0
	var ids []string
	for i, x := range sc.Get("steps").([]any) {
		st := x.(*u.Obj)
		if tk, ok := st.Get("tick").(float64); ok {
			clock += tk
		}
		want = append(want, gold[i])
		rec := u.NewObj()
		p := st.Get("p").(string)
		rec.Set("p", p)
		raw := json.RawMessage("")
		if st.Has("in") {
			s := u.Stringify(st.Get("in"))
			s = regexp.MustCompile(`"\$s(\d+)"`).ReplaceAllStringFunc(s, func(m string) string {
				n, _ := strconv.Atoi(m[3 : len(m)-1])
				return strconv.Quote(ids[n-1])
			})
			raw = json.RawMessage(s)
		}
		reqN++
		kind := "call"
		if p == "ai.tts.stream" {
			kind = "stream"
		}
		req := map[string]any{"t": "req", "id": "r" + strconv.Itoa(reqN), "kind": kind, "name": p}
		if len(raw) > 0 {
			req["input"] = raw
		}
		rb, _ := json.Marshal(req)
		sess := trusted
		if st.Get("untrusted") == true {
			sess = untrusted
		}
		sess.Handle(rb)
		fr := <-frames
		wb, err := contract.EncodeWire(fr)
		if err != nil {
			t.Fatal(err)
		}
		wv, _ := u.Parse(wb)
		w := wv.(*u.Obj)
		if fr.T == "err" {
			rec.Set("err", w.Get("error"))
		} else {
			if !w.Has("output") {
				rec.Set("out", nil)
				rec.Set("undef", true)
			} else {
				rec.Set("out", w.Get("output"))
			}
			for _, id := range sessRe.FindAllString(u.Stringify(rec.Get("out")), -1) {
				dup := false
				for _, x := range ids {
					dup = dup || x == id
				}
				if !dup {
					ids = append(ids, id)
				}
			}
		}
		if len(events) > 0 {
			rec.Set("events", events)
			events = nil
		}
		if st.Get("dump") == true {
			if b, err := os.ReadFile(pf); err == nil {
				rec.Set("file", string(b))
			} else {
				rec.Set("file", nil)
			}
		}
		got = append(got, rec)
	}
	return got, want
}

func TestAIFacadeParity(t *testing.T) {
	scs := mustParse(t, "testdata/b7s-aifacade-scenarios.json")
	gold := mustParse(t, "testdata/b7s-aifacade.json")
	if len(scs) != len(gold) {
		t.Fatalf("scenario count %d vs %d", len(scs), len(gold))
	}
	steps := 0
	for i, x := range scs {
		sc := x.(*u.Obj)
		g := gold[i].(*u.Obj)
		name := sc.Get("name").(string)
		t.Run(name, func(t *testing.T) {
			got, want := runScenario(t, sc, g.Get("steps").([]any))
			for j := range want {
				gs, ws := scrub(u.Stringify(got[:j+1])), scrub(u.Stringify(want[:j+1]))
				if gs != ws {
					t.Fatalf("step %d mismatch\n got: %s\nwant: %s", j, u.Stringify(got[j]), u.Stringify(want[j]))
				}
			}
			steps += len(want)
		})
	}
	t.Logf("aifacade parity: %d scenarios, %d steps", len(scs), steps)
}
