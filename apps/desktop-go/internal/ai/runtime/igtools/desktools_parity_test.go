package igtools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	dparse "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/sandbox"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 回放 scripts/parity/record-b7s-desktools.mjs（同形装配，见脚本头注释）

const deskNow = 1_900_000_000_000

type noTimers struct{}

func (noTimers) SetTimeout(func(), float64) any { return 0 }
func (noTimers) ClearTimeout(any)               {}

type fakeUI struct {
	b        *desktop.PermissionBroker
	answers  []bool
	confirms []any
}

func (f *fakeUI) Request(req desktop.ConfirmRequest) {
	c := u.NewObj("tool", req.Tool, "danger", string(req.Danger), "summary", req.Summary, "argsJson", req.ArgsJSON)
	if req.Preview != nil {
		c.Set("preview", *req.Preview)
	}
	c.Set("dialog", req.Dialog)
	c.Set("rememberable", req.Rememberable)
	c.Set("reason", req.Reason)
	f.confirms = append(f.confirms, c)
	a := true
	if len(f.answers) > 0 {
		a, f.answers = f.answers[0], f.answers[1:]
	}
	go f.b.Answer(req.ID, a, false)
}
func (f *fakeUI) Cancel(string) {}

type fakeCode struct{}

func (fakeCode) Available() []string { return []string{"javascript"} }
func (fakeCode) Run(_ context.Context, lang, code string, o sandbox.RunOpts) (*sandbox.RunResult, error) {
	z := 0
	return &sandbox.RunResult{ExitCode: &z, Stdout: "ran:" + lang + ":" + strconv.Itoa(len([]rune(code))) + ":" + strconv.Itoa(o.TimeoutMs), Ms: 7, Sandbox: "node-permission"}, nil
}

var deskDrop = map[string]bool{"ts": true, "ms": true, "modified": true, "created": true, "createdAt": true, "expiresAt": true, "updatedAt": true, "firedAt": true, "grantedAt": true, "at": true}

func deskStrip(v any) any {
	switch x := v.(type) {
	case []any:
		for i := range x {
			x[i] = deskStrip(x[i])
		}
		return x
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			if deskDrop[k] || (k == "size" && x["type"] == "dir") {
				continue
			}
			out[k] = deskStrip(e)
		}
		return out
	}
	return v
}

var (
	undoRe  = regexp.MustCompile(`"undoId":"[^"]*"`)
	uuidRe  = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	mtimeRe = regexp.MustCompile(`(\\"expectMtimeMs\\": )[0-9.e+]+`)
	tdayRe  = regexp.MustCompile(`trash/\d{4}-\d{2}-\d{2}/`)
)

func TestDesktopToolsParityGolden(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("golden 在 posix 录制（路径分隔符 / 权限语义）；Windows 路径处理由 desktop 包自身测试覆盖")
	}
	sh, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("no tzdata")
	}
	old := time.Local
	time.Local = sh
	t.Cleanup(func() { time.Local = old })

	R := t.TempDir()
	if r, err := filepath.EvalSymlinks(R); err == nil {
		R = r
	}
	H, UD := filepath.Join(R, "home"), filepath.Join(R, "ud")
	w := func(rel string, data []byte) {
		f := filepath.Join(H, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		_ = os.WriteFile(f, data, 0o644)
	}
	w("docs/a.txt", []byte("hello world\nsecond line\n"))
	w("docs/b.md", []byte("# Title\nneedle in md\n"))
	w("docs/sub/c.txt", []byte("deep needle\n"))
	w("docs/data.json", []byte("{\"x\":1}\n"))
	w("docs/long.txt", []byte(strings.Repeat("abcdefghij", 100)))
	w("docs/bin.dat", []byte{1, 0, 2})
	w("ro/r.txt", []byte("read only\n"))
	w("secret.txt", []byte("nope"))
	w("ws/w.txt", []byte("w"))
	_ = os.MkdirAll(UD, 0o755)

	clip, pick := "", ""
	var says []any
	svc := desktop.CreateService(UD, desktop.Ports{Home: H}, nil)
	b := svc.Broker
	ws := filepath.Join(H, "ws")
	b.IsKnownWorkspace = func(d string) bool { return d == ws }
	b.Grant(filepath.Join(H, "docs"), "read-write", "folder", false)
	b.Grant(filepath.Join(H, "ro"), "read", "folder", false)
	ui := &fakeUI{b: b}
	b.UI = ui
	rem := reminders.New(filepath.Join(UD, "rem.json"), func() float64 { return deskNow }, noTimers{})
	svc.Reminders = rem
	defs := DesktopTools(DeskDeps{
		Broker: b, Audit: svc.Audit, Journal: svc.Journal, Trash: svc.Trash,
		Parse: func(p string) dparse.ParseResult { return dparse.ParseFile(p, dparse.ParseOptions{}) },
		Summarize: func(text, instr string) (string, error) {
			r := []rune(text)
			if len(r) > 40 {
				r = r[:40]
			}
			return "SUM(" + strconv.Itoa(utf8.RuneCountInString(instr)) + "):" + string(r), nil
		},
		ProviderFor:      func(string) *desktop.Provider { return nil },
		DescribeProvider: func(p *tools.ToolCallProvider) *desktop.Provider { return svc.ReceiverOf(p.ID, p.BaseURL) },
		PickFolder:       func(string) string { return pick },
		Reminders:        rem,
		ClipboardRead:    func() (string, error) { return clip, nil },
		ClipboardWrite:   func(s string) error { clip = s; return nil },
		Say:              func(s string) { says = append(says, s) },
		Now:              func() float64 { return deskNow },
		Code:             fakeCode{},
		Shell:            &WorkspaceShell{Env: func() []string { return []string{"PATH=" + os.Getenv("PATH"), "LANG=C"} }},
	})
	byName := map[string]tools.Definition{}
	for _, d := range defs {
		byName[d.Name] = d
	}

	var cases []map[string]json.RawMessage
	var golden []any
	readJSON(t, "testdata/b7s-desktools-cases.json", &cases)
	readJSON(t, "testdata/b7s-desktools.json", &golden)
	if len(cases) != len(golden) {
		t.Fatalf("cases %d vs golden %d", len(cases), len(golden))
	}
	var rids []string
	ridRe := regexp.MustCompile(`@@RID(\d+)@@`)
	fill := func(raw json.RawMessage) string {
		s := strings.ReplaceAll(string(raw), "@@H@@", jsonInner(H))
		s = strings.ReplaceAll(s, "@@UD@@", jsonInner(UD))
		return ridRe.ReplaceAllStringFunc(s, func(m string) string {
			k, _ := strconv.Atoi(ridRe.FindStringSubmatch(m)[1])
			if k < len(rids) {
				return rids[k]
			}
			return "rmissing0"
		})
	}
	for i, c := range cases {
		var tool string
		_ = json.Unmarshal(c["tool"], &tool)
		if _, ok := c["posix"]; ok && runtime.GOOS == "windows" {
			continue
		}
		ui.answers, ui.confirms, says = nil, nil, nil
		if raw, ok := c["answers"]; ok {
			_ = json.Unmarshal(raw, &ui.answers)
		}
		if raw, ok := c["clip"]; ok {
			_ = json.Unmarshal(raw, &clip)
		}
		pick = ""
		if raw, ok := c["pick"]; ok && string(raw) != "null" {
			_ = json.Unmarshal([]byte(fill(raw)), &pick)
		}
		ec := tools.ExecContext{ToolCallID: "tc1"}
		if raw, ok := c["provider"]; ok {
			var p struct{ ID, BaseURL string }
			_ = json.Unmarshal(raw, &p)
			ec.Provider = &tools.ToolCallProvider{ID: p.ID, BaseURL: p.BaseURL}
		}
		if raw, ok := c["cwd"]; ok {
			_ = json.Unmarshal([]byte(fill(raw)), &ec.Cwd)
		}
		var in any = aifacade.Undef
		if raw, ok := c["in"]; ok {
			in, _ = u.ParseString(fill(raw))
		}
		before := len(svc.Audit.List(100000))
		rec := map[string]any{"tool": tool}
		def, ok := byName[tool]
		if !ok {
			t.Fatalf("no tool %s", tool)
		}
		out, err := def.Execute(context.Background(), in, ec)
		if err != nil {
			rec["err"] = err.Error()
		} else {
			var o map[string]any
			_ = json.Unmarshal([]byte(u.Stringify(out)), &o)
			if tool == "reminder_create" && o["ok"] == true {
				if d, ok := o["data"].(map[string]any); ok {
					if id, ok := d["id"].(string); ok {
						rids = append(rids, id)
					}
				}
			}
			rec["out"] = deskStrip(o)
		}
		if len(ui.confirms) > 0 {
			rec["confirms"] = ui.confirms
		}
		if len(says) > 0 {
			rec["says"] = says
		}
		if n := len(svc.Audit.List(100000)) - before; n > 0 {
			var a []any
			for _, e := range svc.Audit.List(n) {
				var x any
				_ = json.Unmarshal(e, &x)
				a = append(a, x)
			}
			rec["audit"] = deskStrip(a)
		}
		if tool == "clipboard_write" {
			rec["clip"] = clip
		}
		s := strings.ReplaceAll(u.Stringify(rec), jsonInner(R), "@@R@@")
		for k, id := range rids {
			s = strings.ReplaceAll(s, id, "@@RID"+strconv.Itoa(k)+"@@")
		}
		s = undoRe.ReplaceAllString(s, `"undoId":"@@U@@"`)
		s = uuidRe.ReplaceAllString(s, "@@ID@@")
		s = mtimeRe.ReplaceAllString(s, "${1}@@MT@@")
		s = tdayRe.ReplaceAllString(s, "trash/@@D@@/")
		var gn any
		_ = json.Unmarshal([]byte(s), &gn)
		if !reflect.DeepEqual(gn, golden[i]) {
			want, _ := json.Marshal(golden[i])
			t.Errorf("desk[%d] %s:\n got %s\nwant %s", i, tool, s, want)
		}
	}
}

func jsonInner(s string) string {
	b, _ := json.Marshal(s)
	return string(b[1 : len(b)-1])
}

func readJSON(t *testing.T, f string, v any) {
	t.Helper()
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}
