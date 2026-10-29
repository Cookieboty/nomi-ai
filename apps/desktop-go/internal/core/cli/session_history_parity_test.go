package cli

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

const shTok = "@@SB@@"

var shTokEnc = util.EncodeURIComponent(shTok)

type shFile struct {
	P     string  `json:"p"`
	Text  string  `json:"text"`
	Mtime float64 `json:"mtime"`
	JSON  bool    `json:"json"`
	Zstd  bool    `json:"zstd"`
	Pad   int     `json:"pad"`
	Rep   []any   `json:"rep"`
}

type shScenario struct {
	Name  string            `json:"name"`
	Deps  json.RawMessage   `json:"deps"`
	Files []shFile          `json:"files"`
	Steps []json.RawMessage `json:"steps"`
	Out   []json.RawMessage `json:"out"`
}

type shDeps struct {
	Open           []string                  `json:"open"`
	Tab            *struct{ Reused bool }    `json:"tab"`
	Trash          any                       `json:"trash"`
	Env            map[string]string         `json:"env"`
	GeminiHome     string                    `json:"geminiHome"`
	Gateway        []string                  `json:"gateway"`
	SessionModel   map[string]string         `json:"sessionModel"`
	AccountLabel   map[string]string         `json:"accountLabel"`
	SessionAccount map[string]HistoryAccount `json:"sessionAccount"`
	DB             bool                      `json:"db"`
	Rows           json.RawMessage           `json:"rows"`
}

func jsonEsc(s string) string { x := util.Stringify(s); return x[1 : len(x)-1] }

func shSub(SB, s string) string {
	v := strings.ReplaceAll(s, shTok, SB)
	if filepath.Separator == '\\' {
		v = strings.ReplaceAll(v, SB+"/", SB+`\`)
	}
	return v
}

func shMaterialize(t *testing.T, SB string, f shFile) {
	enc := util.EncodeURIComponent(SB)
	js := jsonEsc(SB)
	segs := strings.Split(f.P, "/")
	for i, x := range segs {
		segs[i] = strings.ReplaceAll(x, shTokEnc, enc)
	}
	p := filepath.Join(append([]string{SB}, segs...)...)
	repl := SB
	if f.JSON {
		repl = js
	}
	text := strings.ReplaceAll(strings.ReplaceAll(f.Text, shTokEnc, enc), shTok, repl)
	if filepath.Separator == '\\' {
		if f.JSON {
			text = strings.ReplaceAll(text, js+"/", js+`\\`)
		} else {
			text = strings.ReplaceAll(text, SB+"/", SB+`\`)
		}
	}
	if len(f.Rep) == 2 {
		text += strings.Repeat(f.Rep[0].(string), int(f.Rep[1].(float64)))
	}
	buf := []byte(text)
	if f.Zstd {
		e, _ := zstd.NewWriter(nil)
		buf = e.EncodeAll(buf, nil)
		e.Close()
	}
	if f.Pad > 0 {
		pad := make([]byte, f.Pad)
		binary.LittleEndian.PutUint32(pad[0:], 0x184d2a50)
		binary.LittleEndian.PutUint32(pad[4:], uint32(f.Pad-8))
		buf = append(buf, pad...)
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o777)
	if err := os.WriteFile(p, buf, 0o666); err != nil {
		t.Fatal(err)
	}
	mt := time.UnixMilli(int64(f.Mtime))
	_ = os.Chtimes(p, mt, mt)
}

func canonJSON(t *testing.T, b []byte) string {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("bad json %s: %v", b, err)
	}
	out, _ := json.Marshal(v)
	return string(out)
}

func TestSessionHistoryGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s-history.json", filepath.Join("testdata", "b7s-history.json"))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Platform  string       `json:"platform"`
		Scenarios []shScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if g.Platform != usage.Platform() {
		t.Skipf("golden recorded on %s", g.Platform)
	}
	steps := 0
	for _, sc := range g.Scenarios {
		steps += len(sc.Steps)
		t.Run(sc.Name, func(t *testing.T) { runHistoryScenario(t, sc) })
	}
	if len(g.Scenarios) < 15 || steps < 130 {
		t.Fatalf("golden too small: %d scenarios / %d steps", len(g.Scenarios), steps)
	}
}

func runHistoryScenario(t *testing.T, sc shScenario) {
	SB, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(filepath.Join(SB, "work"), 0o777)
	_ = os.MkdirAll(filepath.Join(SB, "home"), 0o777)
	for _, f := range sc.Files {
		shMaterialize(t, SB, f)
	}
	var d *shDeps
	if len(sc.Deps) > 0 && string(sc.Deps) != "null" {
		d = &shDeps{}
		if err := json.Unmarshal(sc.Deps, d); err != nil {
			t.Fatal(err)
		}
	}
	calls := []any{}
	var rows []*util.Obj
	rowsFail := false
	setRows := func(raw json.RawMessage) {
		rows = nil
		if len(raw) == 0 {
			return
		}
		v, _ := util.ParseString(shSub(SB, string(raw)))
		if arr, ok := v.([]any); ok {
			for _, r := range arr {
				rows = append(rows, r.(*util.Obj))
			}
		}
	}
	db := filepath.Join(SB, "home", ".codex", "state_5.sqlite")
	dbN := 1
	var svc *SessionHistoryService
	if d != nil {
		setRows(d.Rows)
		if d.DB {
			_ = os.MkdirAll(filepath.Dir(db), 0o777)
			_ = os.WriteFile(db, []byte("x"), 0o666)
			_ = os.Chtimes(db, time.UnixMilli(1000), time.UnixMilli(1000))
		}
		env := util.NewObj()
		for k, v := range d.Env {
			env.Set(k, shSub(SB, v))
		}
		deps := SessionHistoryDeps{
			Home: filepath.Join(SB, "home"), HasHome: true,
			DshHome: filepath.Join(SB, "home", ".dsh"), HasDshHome: true,
			Env:    env,
			Logger: shLogger{&calls},
			OpenKeys: func() map[string]bool {
				m := map[string]bool{}
				for _, k := range d.Open {
					m[k] = true
				}
				return m
			},
			OpenTitle: func(b, id, title string) { calls = append(calls, []any{"openTitle", b, id, title}) },
			SessionModel: func(b, id string) string { return d.SessionModel[b+":"+id] },
			GatewaySession: func(b, id string) bool {
				for _, k := range d.Gateway {
					if k == b+":"+id {
						return true
					}
				}
				return false
			},
			AccountLabel: func(b, id string) string { return d.AccountLabel[id] },
			SessionAccount: func(b, id string) *HistoryAccount {
				if a, ok := d.SessionAccount[b+":"+id]; ok {
					return &a
				}
				return nil
			},
			CodexThreads: func(string) *jsrt.Promise[[]*util.Obj] {
				calls = append(calls, []any{"codexThreads"})
				if rowsFail {
					return jsrt.Rejected[[]*util.Obj](errors.New("worker crashed"))
				}
				return jsrt.Resolved(rows)
			},
		}
		if d.GeminiHome != "" {
			deps.GeminiHome = shSub(SB, d.GeminiHome)
		}
		if d.Tab != nil {
			reused := d.Tab.Reused
			deps.OpenTab = func(o *util.Obj) HistoryOpenTabResult {
				c := o.Clone()
				ms := o.Get("messages").([]any)
				c.Set("messages", float64(len(ms)))
				if len(ms) > 0 {
					c.Set("firstMsg", ms[0])
				} else {
					c.Set("firstMsg", nil)
				}
				calls = append(calls, []any{"openTab", c})
				sid, _ := o.Get("sessionId").(string)
				return HistoryOpenTabResult{Tab: util.NewObj("id", "tab-"+sid), Reused: reused}
			}
		}
		if d.Trash != nil && d.Trash != false {
			fail := d.Trash == "fail"
			deps.Trash = func(p string) *jsrt.Promise[struct{}] {
				calls = append(calls, []any{"trash", p})
				if fail {
					return jsrt.Rejected[struct{}](errors.New("trash denied"))
				}
				_ = os.RemoveAll(p)
				return jsrt.Resolved(struct{}{})
			}
		}
		svc = NewSessionHistoryService(deps)
	}
	scrub := func(txt string) string {
		return strings.ReplaceAll(strings.ReplaceAll(txt, jsonEsc(SB), "<SB>"), util.EncodeURIComponent(SB), "<SBENC>")
	}
	relP := func(r string) string { return filepath.Join(append([]string{SB}, strings.Split(r, "/")...)...) }
	for i, raw := range sc.Steps {
		var st []json.RawMessage
		_ = json.Unmarshal(raw, &st)
		var op string
		_ = json.Unmarshal(st[0], &op)
		str := func(k int) string { var s string; _ = json.Unmarshal(st[k], &s); return s }
		anyv := func(k int) any { v, _ := util.ParseString(string(st[k])); return v }
		opts := func(k int) HistoryPageOpts {
			var o struct {
				Offset, Limit *float64
				Force         bool
			}
			_ = json.Unmarshal(st[k], &o)
			return HistoryPageOpts{Offset: o.Offset, Limit: o.Limit, Force: o.Force}
		}
		var r any
		var rerr error
		undef := false
		jsrt.Run(func() {
			aw := func(p *jsrt.Promise[*util.Obj]) { v, e := jsrt.Await(p); r, rerr = v, e }
			switch op {
			case "meta":
				r = CodexSessionMeta(str(1))
			case "sub":
				r = IsCodexSubagentSource(anyv(1))
			case "route":
				s, _ := anyv(1).(string)
				r = CodexRoute(s)
			case "client":
				s, _ := anyv(1).(string)
				if c := CodexClient(s, anyv(2)); c != "" {
					r = c
				} else {
					undef = true
				}
			case "changed":
				conv := func(v any) ([]string, map[string]*util.Obj) {
					ids := []string{}
					m := map[string]*util.Obj{}
					for _, e := range v.([]any) {
						pr := e.([]any)
						id := pr[0].(string)
						if _, ok := m[id]; !ok {
							ids = append(ids, id)
						}
						m[id] = pr[1].(*util.Obj)
					}
					return ids, m
				}
				a, am := conv(anyv(1))
				b, bm := conv(anyv(2))
				out := []any{}
				for _, x := range CodexRowsChanged(a, am, b, bm) {
					out = append(out, x)
				}
				r = out
			case "list":
				aw(svc.List(str(1), opts(2)))
			case "index":
				aw(svc.Index(str(1), opts(2)))
			case "transcript":
				aw(svc.Transcript(str(1), str(2)))
			case "transcriptMeta":
				tr, _ := jsrt.Await(svc.Transcript(str(1), str(2)))
				ms := tr.Get("messages").([]any)
				o := util.NewObj("n", float64(len(ms)), "truncated", tr.Get("truncated"))
				if n, ok := tr.Get("note").(string); ok {
					o.Set("note", n)
				}
				if len(ms) > 0 {
					c, _ := ms[0].(*util.Obj).Get("content").(string)
					o.Set("first", util.UTF16Slice0(c, 40))
				}
				r = o
			case "open":
				aw(svc.Open(str(1), str(2)))
			case "remove":
				aw(svc.Remove(str(1), str(2)))
			case "write":
				var f shFile
				_ = json.Unmarshal(st[1], &f)
				shMaterialize(t, SB, f)
			case "rm":
				_ = os.RemoveAll(relP(str(1)))
			case "exists":
				_, e := os.Stat(relP(str(1)))
				r = e == nil
			case "calls":
				r = calls
				calls = []any{}
			case "rows":
				setRows(st[1])
				rowsFail = false
			case "rowsFail":
				rowsFail = true
			case "touchDb":
				dbN++
				_ = os.WriteFile(db, []byte(strings.Repeat("x", dbN)), 0o666)
				mt := time.UnixMilli(int64(1000 * dbN))
				_ = os.Chtimes(db, mt, mt)
			default:
				t.Fatalf("bad op %s", op)
			}
		})
		var got string
		switch {
		case rerr != nil:
			got = util.Stringify(util.NewObj("err", scrub(rerr.Error())))
		case undef:
			got = `{"undef":true}`
		default:
			got = scrub(util.Stringify(util.NewObj("v", r)))
		}
		want := canonJSON(t, sc.Out[i])
		if g := canonJSON(t, []byte(got)); g != want {
			t.Errorf("%s step %d %s:\n got %s\nwant %s", sc.Name, i, raw, trunc(g), trunc(want))
		}
	}
}

func trunc(s string) string {
	if len(s) > 3000 {
		return s[:3000] + "…"
	}
	return s
}

type shLogger struct{ calls *[]any }

func (l shLogger) Warn(m string, _ ...any) { *l.calls = append(*l.calls, []any{"warn", m}) }

var _ = bytes.NewReader
