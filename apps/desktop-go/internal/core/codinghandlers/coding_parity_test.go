package codinghandlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// fake = 录制脚本里的假服务（{m, a} 回显；fail = 同步方法抛错 / 异步方法 reject）
type fake struct{ fail bool }

func (f *fake) echo(m string, a ...any) *util.Obj {
	if f.fail {
		panic(jsrt.JSThrow{Message: "boom " + m})
	}
	if a == nil {
		a = []any{}
	}
	return util.NewObj("m", m, "a", a)
}
func (f *fake) aecho(m string, a ...any) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) { return f.echo(m, a...), nil })
}
func (f *fake) err(m string) error {
	if f.fail {
		return errors.New("boom " + m)
	}
	return nil
}

func (f *fake) Snapshot() *util.Obj           { return f.echo("snapshot") }
func (f *fake) AddExternal(raw any) *util.Obj { return f.echo("addExternal", raw) }
func (f *fake) RemoveExternal(id string) bool { f.echo("removeExternal", id); return id == "yes" }
func (f *fake) TestExternalInTemp(raw any) *jsrt.Promise[*util.Obj] {
	return f.aecho("testExternalInTemp", raw)
}
func (f *fake) Inspect(refresh bool) *jsrt.Promise[[]*util.Obj] {
	return jsrt.Async(func() ([]*util.Obj, error) { return []*util.Obj{f.echo("inspect", refresh)}, nil })
}
func (f *fake) PreviewUpdate(k, s string) *jsrt.Promise[*util.Obj] {
	return f.aecho("previewUpdate", k, s)
}
func (f *fake) Run(k, s string) *jsrt.Promise[*util.Obj] { return f.aecho("run", k, s) }
func (f *fake) Job(k string) *util.Obj {
	if k == "codex" {
		return nil
	}
	return f.echo("job", k)
}
func (f *fake) BusyKinds() []string      { f.echo("busyKinds"); return []string{"claude", "grok"} }
func (f *fake) DismissJob(k string) bool { f.echo("dismissJob", k); return k == "claude" }
func (f *fake) Settings() *util.Obj      { return f.echo("settings") }
func (f *fake) SetSettings(raw any) (*util.Obj, error) {
	if e := f.err("setSettings"); e != nil {
		return nil, e
	}
	return f.echo("setSettings", raw), nil
}
func (f *fake) Pin(c, t any) (string, error) {
	if e := f.err("pin"); e != nil {
		return "", e
	}
	f.echo("pin", c, t)
	if s, ok := c.(string); ok && s != "none" {
		return s, nil
	}
	return "", nil
}
func (f *fake) ClearPin(t any) { f.echo("clearPin", t) }
func (f *fake) StatusOf(id string) *util.Obj {
	if id == "missing" {
		return nil
	}
	return f.echo("statusOf", id)
}
func opts(o cli.HistoryPageOpts) *util.Obj {
	n := func(p *float64) any {
		if p == nil {
			return nil
		}
		return *p
	}
	return util.NewObj("offset", n(o.Offset), "limit", n(o.Limit), "force", o.Force)
}
func (f *fake) List(b string, o cli.HistoryPageOpts) *jsrt.Promise[*util.Obj] {
	return f.aecho("list", b, opts(o))
}
func (f *fake) Index(b string, o cli.HistoryPageOpts) *jsrt.Promise[*util.Obj] {
	return f.aecho("index", b, opts(o))
}
func (f *fake) Open(b, id string) *jsrt.Promise[*util.Obj]   { return f.aecho("open", b, id) }
func (f *fake) Remove(b, id string) *jsrt.Promise[*util.Obj] { return f.aecho("remove", b, id) }

func codingServices(f *fake) CodingServices {
	if f == nil {
		return CodingServices{}
	}
	return CodingServices{
		Plugins:  func() Plugins { return f },
		Updates:  func() Updates { return f },
		Delegate: func() Delegate { return f },
		History:  func() History { return f },
	}
}

func cnorm(v any) string {
	b, _ := json.Marshal(v)
	var x any
	json.Unmarshal(b, &x)
	y, _ := json.Marshal(x)
	return string(y)
}

func TestCodingGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s2-coding.json", "testdata/b7s2-coding.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
		Mode  string          `json:"mode"`
		Out   json.RawMessage `json:"out"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		var f *fake
		if c.Mode != "missing" {
			f = &fake{fail: c.Mode == "fail"}
		}
		r := contract.NewRouter()
		RegisterCoding(r, codingServices(f))
		ch := make(chan contract.ServerFrame, 1)
		s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(fr contract.ServerFrame) { ch <- fr })
		b, _ := json.Marshal(contract.ClientFrame{T: "req", ID: "1", Kind: "call", Name: c.Name, Input: c.Input})
		s.Handle(b)
		fr := <-ch
		s.Close()
		var got any
		switch fr.T {
		case "res":
			got = map[string]any{"ok": fr.Output}
		case "err":
			got = map[string]any{"err": fr.Error}
		default:
			got = fmt.Sprintf("frame %+v", fr)
		}
		var want any
		json.Unmarshal(c.Out, &want)
		if cnorm(got) != cnorm(want) {
			t.Errorf("#%d %s %s %s:\n got %s\nwant %s", i, c.Name, c.Mode, c.Input, cnorm(got), cnorm(want))
		}
	}
}
