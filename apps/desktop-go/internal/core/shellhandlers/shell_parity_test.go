package shellhandlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/diagnostics"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type shellStep struct {
	Op  string          `json:"op"`
	OK  json.RawMessage `json:"ok"`
	Err *string         `json:"err"`
}

type diagScenario struct {
	Name    string            `json:"name"`
	Dev     bool              `json:"dev"`
	Env     map[string]string `json:"env"`
	Observe *string           `json:"observe"`
	File    *string           `json:"file"`
	Files   [][]any           `json:"files"`
	Steps   [][]any           `json:"steps"`
	Log     []shellStep       `json:"log"`
}

func loadGolden(t *testing.T, name string, v any) {
	t.Helper()
	p, _ := paritytest.Golden(t, name, filepath.Join("testdata", name))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

// normJSON：结果 → JSON（沙箱路径换成 <SB>，统一正斜杠转义与 Node 的 JSON.stringify 一致）
func normJSON(t *testing.T, v any, sb string) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	q, _ := json.Marshal(sb)
	s := strings.ReplaceAll(string(b), string(q[1:len(q)-1]), "<SB>")
	var out any
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func rawAny(r json.RawMessage) any {
	var v any
	_ = json.Unmarshal(r, &v)
	return v
}

// diagHook：变异检查（mutation）用，测试里替换行为以确认 golden 能抓住差异
var diagMutate func(op string, v any) any

func TestDiagnosticsParity(t *testing.T) {
	var g struct {
		Now       int64          `json:"now"`
		Version   string         `json:"version"`
		Platform  string         `json:"platform"`
		Scenarios []diagScenario `json:"scenarios"`
	}
	loadGolden(t, "shell_diagnostics.json", &g)
	if len(g.Scenarios) == 0 {
		t.Fatal("empty golden")
	}
	sb, _ := filepath.EvalSymlinks(t.TempDir())
	n := 0
	for _, sc := range g.Scenarios {
		ud := filepath.Join(sb, "diag", sc.Name)
		_ = os.MkdirAll(filepath.Join(ud, "gateway"), 0o755)
		if sc.Observe != nil {
			_ = os.WriteFile(filepath.Join(ud, "gateway", "observe.json"), []byte(*sc.Observe), 0o644)
		}
		if sc.File != nil {
			_ = os.WriteFile(filepath.Join(ud, "diagnostics.json"), []byte(*sc.File), 0o644)
		}
		for _, f := range sc.Files {
			dir := filepath.Join(ud, "gateway", "trace")
			if f[0] == "logs" {
				dir = filepath.Join(ud, "logs")
			}
			_ = os.MkdirAll(dir, 0o755)
			p := filepath.Join(dir, f[1].(string))
			_ = os.WriteFile(p, []byte(f[2].(string)), 0o644)
			mt := time.UnixMilli(g.Now - int64(f[3].(float64)*3600_000))
			_ = os.Chtimes(p, mt, mt)
		}
		var changes []bool
		type saveCall struct {
			DefaultPath string           `json:"defaultPath"`
			Filters     []map[string]any `json:"filters"`
			Parent      string           `json:"parent"`
		}
		saveCalls := []saveCall{}
		var saveRet *string
		openRet := ""
		dev := sc.Dev
		env := sc.Env
		if env == nil {
			env = map[string]string{}
		}
		svc := diagnostics.New(diagnostics.Deps{
			UserData: ud, Dev: &dev, Env: env, Now: func() int64 { return g.Now }, Platform: g.Platform,
			LegacyEnabled: func() bool { return diagnostics.ReadLegacyGatewayTrace(filepath.Join(ud, "gateway")) },
			OnChange:      func(on bool) { changes = append(changes, on) },
			Ports: diagnostics.Ports{
				IsPackaged: func() bool { return !dev },
				Version:    func() string { return g.Version },
				SaveFile: func(_, def string, fs []diagnostics.FileFilter) (string, error) {
					ff := []map[string]any{}
					for _, f := range fs {
						ff = append(ff, map[string]any{"name": f.Name, "extensions": f.Extensions})
					}
					saveCalls = append(saveCalls, saveCall{def, ff, "focused"})
					if saveRet == nil {
						return "", nil
					}
					return *saveRet, nil
				},
				OpenPath: func(string) string { return openRet },
			},
		})
		for i, st := range sc.Steps {
			op := st[0].(string)
			var r any
			var err error
			switch op {
			case "view":
				r = svc.View()
			case "set":
				r = svc.Set(st[1].(bool))
			case "file":
				if b, e := os.ReadFile(filepath.Join(ud, "diagnostics.json")); e == nil {
					r = string(b)
				}
			case "changes":
				if changes == nil {
					changes = []bool{}
				}
				r = changes
			case "open":
				openRet = st[1].(string)
				r, err = svc.OpenLogFolder()
			case "logDirExists":
				_, e := os.Stat(filepath.Join(ud, "logs"))
				r = e == nil
			case "export":
				saveRet = nil
				if s, ok := st[1].(string); ok {
					p := filepath.Join(ud, filepath.FromSlash(s))
					saveRet = &p
				}
				r = svc.ExportBundle()
			case "saveCalls":
				r = saveCalls
			case "zip":
				b, _ := os.ReadFile(filepath.Join(ud, st[1].(string)))
				zr, e := zip.NewReader(bytes.NewReader(b), int64(len(b)))
				if e != nil {
					t.Fatalf("%s: bad zip %v", sc.Name, e)
				}
				ents := [][]string{}
				for _, f := range zr.File {
					rc, _ := f.Open()
					d, _ := io.ReadAll(rc)
					rc.Close()
					ents = append(ents, []string{f.Name, string(d)})
				}
				r = ents
			default:
				t.Fatalf("unknown op %s", op)
			}
			if diagMutate != nil {
				r = diagMutate(op, r)
			}
			want := sc.Log[i]
			if want.Err != nil {
				if err == nil {
					t.Errorf("%s#%d %s: want err %q, got ok %v", sc.Name, i, op, *want.Err, r)
				} else if got := normJSON(t, err.Error(), sb); got != *want.Err {
					t.Errorf("%s#%d %s: err %q want %q", sc.Name, i, op, got, *want.Err)
				}
				continue
			}
			if err != nil {
				t.Errorf("%s#%d %s: unexpected err %v", sc.Name, i, op, err)
				continue
			}
			if got, w := normJSON(t, r, sb), rawAny(want.OK); !reflect.DeepEqual(got, w) {
				t.Errorf("%s#%d %s:\n got %v\nwant %v", sc.Name, i, op, got, w)
			}
			n++
		}
	}
	t.Logf("diagnostics parity: %d steps", n)
}
