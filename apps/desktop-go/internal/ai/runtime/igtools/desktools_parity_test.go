package igtools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	dparse "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/sandbox"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
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

// fakeCode：缺省假沙箱；real=true 时转给真实 CodeSandbox（同录制脚本 real:true 用例）
type fakeCode struct {
	real *bool
	sbx  *sandbox.CodeSandbox
}

func (f fakeCode) Available() []string {
	if *f.real {
		return f.sbx.Available()
	}
	return []string{"javascript"}
}
func (f fakeCode) Run(ctx context.Context, lang, code string, o sandbox.RunOpts) (*sandbox.RunResult, error) {
	if *f.real {
		return f.sbx.Run(ctx, lang, code, o)
	}
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
	sbxRe   = regexp.MustCompile(`[^\s()'"]*cd-sbx-[A-Za-z0-9]+`)
	uuidRe  = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	mtimeRe = regexp.MustCompile(`("expectMtimeMs": )[0-9.e+]+`)
	tdayRe  = regexp.MustCompile(`trash([\\/]+)\d{4}-\d{2}-\d{2}([\\/]+)`)
)

// deskNorm 同录制脚本 norm：按值换临时根各写法 / 提醒 id / uuid / mtime / 回收站日期，undoId 键值整体替换
func deskNorm(v any, rv, rids []string) any {
	str := func(s string) string {
		for _, r := range rv {
			s = strings.ReplaceAll(s, r, "@@R@@")
		}
		for k, id := range rids {
			s = strings.ReplaceAll(s, id, "@@RID"+strconv.Itoa(k)+"@@")
		}
		s = sbxRe.ReplaceAllString(s, "@@SBX@@")
		s = uuidRe.ReplaceAllString(s, "@@ID@@")
		s = mtimeRe.ReplaceAllString(s, "${1}@@MT@@")
		return tdayRe.ReplaceAllString(s, "trash${1}@@D@@${2}")
	}
	switch x := v.(type) {
	case string:
		return str(x)
	case []any:
		for i := range x {
			x[i] = deskNorm(x[i], rv, rids)
		}
		return x
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			if _, ok := e.(string); ok && k == "undoId" {
				out[str(k)] = "@@U@@"
				continue
			}
			out[str(k)] = deskNorm(e, rv, rids)
		}
		return out
	}
	return v
}

func TestDesktopToolsParityGolden(t *testing.T) {
	gpath, live := paritytest.Golden(t, "b7s-desktools.json", "testdata/b7s-desktools.json")
	if !live && runtime.GOOS == "windows" {
		// 提交的 golden 在 Linux 录制；Windows 比对 CI 现场录制（desktop-go.yml live Node goldens）
		t.Skip("committed golden is POSIX; Windows compares against the live CI recording (NOMI_LIVE_GOLDENS)")
	}
	sh, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("no tzdata")
	}
	old := time.Local
	time.Local = sh
	t.Cleanup(func() { time.Local = old })

	R0 := t.TempDir()
	R := R0
	if r, err := filepath.EvalSymlinks(R); err == nil {
		R = r
	}
	rv := []string{}
	for _, r := range []string{R0, R} {
		rv = append(rv, r, filepath.ToSlash(r), jsonInner(r))
	}
	sort.Slice(rv, func(i, j int) bool { return len(rv[i]) > len(rv[j]) })
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
	realCode, noRun := false, false
	// 录制脚本 real 用例用 process.execPath；Go 取 PATH 上同一个 node（D-B7-S2-5）
	nodeBin, _ := exec.LookPath("node")
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
		Code:             fakeCode{real: &realCode, sbx: sandbox.New(sandbox.Options{NodeBin: nodeBin, RunAsNode: &noRun})},
		Shell:            &WorkspaceShell{Env: func() []string { return []string{"PATH=" + os.Getenv("PATH"), "LANG=C"} }},
	})
	byName := map[string]tools.Definition{}
	for _, d := range defs {
		byName[d.Name] = d
	}

	var cases []map[string]json.RawMessage
	var golden []any
	readJSON(t, "testdata/b7s-desktools-cases.json", &cases)
	readJSON(t, gpath, &golden)
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
		_, px := c["posix"]
		_, wn := c["win"]
		if (px && runtime.GOOS == "windows") || (wn && runtime.GOOS != "windows") {
			if !reflect.DeepEqual(golden[i], map[string]any{"tool": tool, "skip": true}) {
				t.Errorf("desk[%d] %s: golden not skipped on this platform: %v", i, tool, golden[i])
			}
			continue
		}
		_, realCode = c["real"]
		if realCode && nodeBin == "" {
			paritytest.SkipOrFail(t, "node not on PATH")
			return
		}
		// 用例可设「全部自动」与权限模式（缺省：关 / acceptEdits，与录制脚本一致）
		var autoOn bool
		if raw, ok := c["autoApprove"]; ok {
			_ = json.Unmarshal(raw, &autoOn)
		}
		mode := "acceptEdits"
		if raw, ok := c["mode"]; ok {
			_ = json.Unmarshal(raw, &mode)
		}
		b.AutoApprove = func() bool { return autoOn }
		b.PermissionMode = func() desktop.PermMode { return mode }
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
		var gn any
		_ = json.Unmarshal([]byte(u.Stringify(rec)), &gn)
		gn = deskNorm(gn, rv, rids)
		if !reflect.DeepEqual(gn, golden[i]) {
			sb, _ := json.Marshal(gn)
			s := string(sb)
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
