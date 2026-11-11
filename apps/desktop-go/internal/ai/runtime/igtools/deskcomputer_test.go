package igtools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	pngenc "image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/computer"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// fakeAD：假的 agent-desktop（snapshot 给出 Mail 里的「Send」「Subject」两个按钮）
func fakeAD(calls *[]string) computer.ExecFn {
	return func(_ context.Context, _ string, args []string, _ string) ([]byte, error) {
		*calls = append(*calls, strings.Join(args, " "))
		var data any = map[string]any{}
		switch args[0] {
		case "screenshot":
			data = map[string]any{"data": testPNG(400, 300), "width": 400, "height": 300, "scale_factor": 2}
		case "list-windows":
			data = []any{map[string]any{"bounds": map[string]any{"x": 100, "y": 50, "width": 200, "height": 150}, "is_focused": true}}
		}
		if args[0] == "snapshot" {
			data = map[string]any{"app": "Mail", "snapshot_id": "s1", "ref_count": 2, "complete": true,
				"tree": map[string]any{"role": "window", "name": "New Message", "children": []any{
					map[string]any{"role": "button", "name": "Send", "ref_id": "@s1:e1"},
					map[string]any{"role": "textfield", "name": "Subject", "ref_id": "@s1:e2"},
				}}}
		}
		b, _ := json.Marshal(map[string]any{"version": "2.6", "ok": true, "command": args[0], "data": data})
		return b, nil
	}
}

type cuEnv struct {
	svc    *desktop.Service
	ui     *holdUI
	calls  []string
	defs   map[string]tools.Definition
	cu     *computer.Service
	vision string // 视觉模型的回复（"" = 没设置视觉模型）
}

func testPNG(w, h int) string {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var b bytes.Buffer
	_ = pngenc.Encode(&b, img)
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

func newCuEnv(t *testing.T) *cuEnv {
	t.Helper()
	R := t.TempDir()
	UD := filepath.Join(R, "ud")
	_ = os.MkdirAll(UD, 0o755)
	svc := desktop.CreateService(UD, desktop.Ports{Home: filepath.Join(R, "home")}, nil)
	ui := &holdUI{reqs: make(chan desktop.ConfirmRequest, 8)}
	svc.Broker.UI = ui
	e := &cuEnv{svc: svc, ui: ui, defs: map[string]tools.Definition{}}
	cu := computer.New(computer.Options{Resolve: func() string { return "/bin/agent-desktop" }, Exec: fakeAD(&e.calls),
		Getenv: func(string) string { return "" }, ShotsDir: filepath.Join(R, "shots")})
	e.cu = cu
	vision := func() (computer.AskVision, *desktop.Provider, string, bool) {
		if e.vision == "" {
			return nil, nil, "", false
		}
		return func(context.Context, string, []byte) (string, error) { return e.vision, nil },
			&desktop.Provider{ID: "local", Name: "local", Local: true}, "qwen-vl", true
	}
	for _, d := range DesktopTools(DeskDeps{Broker: svc.Broker, Audit: svc.Audit, Journal: svc.Journal, Trash: svc.Trash,
		ProviderFor: func(string) *desktop.Provider { return nil }, Computer: cu, ComputerVision: vision}) {
		e.defs[d.Name] = d
	}
	return e
}

func (e *cuEnv) call(t *testing.T, name, in string) map[string]any {
	t.Helper()
	v, _ := u.ParseString(in)
	out, err := e.defs[name].Execute(context.Background(), v, tools.ExecContext{ToolCallID: "tc1"})
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	_ = json.Unmarshal([]byte(u.Stringify(out)), &o)
	return o
}

// answer：放行下一次确认，并把确认请求交给测试检查
func (e *cuEnv) answer(ok bool) chan desktop.ConfirmRequest {
	got := make(chan desktop.ConfirmRequest, 1)
	go func() { r := <-e.ui.reqs; got <- r; e.svc.Broker.Answer(r.ID, ok, false) }()
	return got
}

func TestComputerToolsRegistered(t *testing.T) {
	e := newCuEnv(t)
	for _, n := range ComputerToolNames {
		d, ok := e.defs[n]
		if !ok {
			t.Fatalf("%s not registered", n)
		}
		if d.Available == nil || d.Available() != (n != "computer_locate") {
			t.Fatalf("%s availability: computer_locate needs a vision model, the rest only agent-desktop", n)
		}
		if _, ok := deskSchemas[n]; !ok {
			t.Fatalf("%s has no schema", n)
		}
		if _, ok := desktop.ToolDanger[n]; !ok {
			t.Fatalf("%s has no danger level", n)
		}
	}
}

func TestComputerSnapshotThenSensitiveClick(t *testing.T) {
	e := newCuEnv(t)
	got := e.answer(true)
	o := e.call(t, "computer_snapshot", `{"app":"Mail"}`)
	if o["ok"] != true {
		t.Fatalf("snapshot: %v", o)
	}
	<-got
	tree := o["data"].(map[string]any)["tree"].(string)
	if !strings.Contains(tree, `button "Send" [@s1:e1]`) || !strings.Contains(tree, `trust="untrusted"`) {
		t.Fatalf("tree: %s", tree)
	}
	// 「Send」是发送类按钮：强制弹窗确认，拒绝后不执行
	got = e.answer(false)
	o = e.call(t, "computer_click", `{"ref":"@s1:e1"}`)
	req := <-got
	if !req.Dialog || !strings.Contains(req.Summary, "⚠️") {
		t.Fatalf("sensitive click must force a dialog: %+v", req)
	}
	if errCode(o) != "user_denied" {
		t.Fatalf("want user_denied, got %v", o)
	}
	for _, c := range e.calls {
		if strings.HasPrefix(c, "click") {
			t.Fatal("denied click reached agent-desktop")
		}
	}
}

func TestComputerUnknownRefAndBlockedApp(t *testing.T) {
	e := newCuEnv(t)
	if o := e.call(t, "computer_click", `{"ref":"@zz:e9"}`); errCode(o) != "unknown_ref" {
		t.Fatalf("%v", o)
	}
	if o := e.call(t, "computer_snapshot", `{"app":"1Password"}`); errCode(o) != "blocked_app" {
		t.Fatalf("%v", o)
	}
	if o := e.call(t, "computer_press", `{"app":"Keychain Access","keys":"cmd+c"}`); errCode(o) != "blocked_app" {
		t.Fatalf("%v", o)
	}
	if len(e.calls) != 0 {
		t.Fatalf("nothing should reach agent-desktop: %v", e.calls)
	}
}

func TestComputerGate(t *testing.T) {
	g := toolGates["computer_click"]
	if !g(tools.Turn{ConvoText: "帮我在备忘录里新建一条笔记"}) || !g(tools.Turn{ConvoText: "click the save button"}) {
		t.Fatal("should be relevant")
	}
	if g(tools.Turn{ConvoText: "今天天气怎么样"}) {
		t.Fatal("should not be relevant")
	}
}

func TestComputerObserveAfterAction(t *testing.T) {
	e := newCuEnv(t)
	go func() { // 放行所有确认
		for r := range e.ui.reqs {
			e.svc.Broker.Answer(r.ID, true, false)
		}
	}()
	if o := e.call(t, "computer_snapshot", `{"app":"Mail"}`); o["ok"] != true {
		t.Fatalf("%v", o)
	}
	o := e.call(t, "computer_click", `{"ref":"@s1:e2"}`)
	d := o["data"].(map[string]any)
	if after, _ := d["after"].(string); !strings.Contains(after, `textfield "Subject"`) {
		t.Fatalf("click should read the UI back: %v", o)
	}
	n := len(e.calls)
	o = e.call(t, "computer_click", `{"ref":"@s1:e2","observe":false}`)
	if _, has := o["data"].(map[string]any)["after"]; has || len(e.calls) != n+1 {
		t.Fatalf("observe=false must not snapshot: %v %v", o, e.calls[n:])
	}
}

func TestComputerStopBlocksCalls(t *testing.T) {
	e := newCuEnv(t)
	e.cu.StopAll()
	if o := e.call(t, "computer_list_apps", `{}`); errCode(o) != "stopped" {
		t.Fatalf("%v", o)
	}
	if len(e.calls) != 0 {
		t.Fatal("stopped calls must not reach agent-desktop")
	}
}

func TestComputerLocate(t *testing.T) {
	e := newCuEnv(t)
	e.vision = `好的 {"found": true, "x": 200, "y": 150, "confidence": 0.9, "note": "red button"}`
	got := e.answer(true)
	o := e.call(t, "computer_locate", `{"app":"Paint","target":"red button"}`)
	req := <-got
	if !strings.Contains(req.Summary, "qwen-vl") {
		t.Fatalf("confirm should name the vision model: %s", req.Summary)
	}
	d := o["data"].(map[string]any)
	// 窗口 200x150 点、截图 400x300 像素：图片中心 (200,150) → 窗口中心 (100+100, 50+75)
	if d["found"] != true || d["x"] != float64(200) || d["y"] != float64(125) {
		t.Fatalf("%v", o)
	}
}

func TestComputerAuditSourceForCli(t *testing.T) {
	e := newCuEnv(t)
	ctx := WithRequester(context.Background(), "Claude Code")
	v, _ := u.ParseString(`{}`)
	if _, err := e.defs["computer_list_apps"].Execute(ctx, v, tools.ExecContext{}); err != nil {
		t.Fatal(err)
	}
	list := e.svc.AuditList(float64(10), float64(0))
	if !strings.Contains(u.Stringify(list), `"source":"cli:Claude Code"`) {
		t.Fatalf("audit should record the coding agent: %s", u.Stringify(list))
	}
}
