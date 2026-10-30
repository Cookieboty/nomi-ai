package quality

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// goldenCost = record-quality.mjs 的 cost
func goldenCost(model string, tk *u.Obj) (float64, bool) {
	if !strings.HasPrefix(model, "gpt") {
		return 0, false
	}
	n := func(k string) float64 { f, _ := numOf(nullish(get(tk, k), 0.0)); return f }
	// 显式 float64() 阻止 arm64 上 Go 编译器融合乘加（FMA），保证与 V8 逐步舍入一致
	return float64(float64(n("input")*1.25e-6)+float64(n("output")*1e-5)) + float64(n("cacheRead")*1.25e-7), true
}

func norm(v any) string {
	p, err := u.ParseString(u.Stringify(v))
	if err != nil {
		return "<bad>" + err.Error()
	}
	return u.Stringify(p)
}

func TestQualityGolden(t *testing.T) {
	// 提交的 golden 固定 3 个时区（TZ 子进程录制；CI 只在 Linux 现场重录并 diff，见 desktop-go.yml）
	p := "testdata/quality.json"
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	gv, err := u.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	g := gv.(*u.Obj)
	labels := obj(g.Get("labels"))
	labelOf := func(dim, key string) (string, bool) {
		s, ok := get(obj(labels.Get(dim)), key).(string)
		return s, ok
	}
	evs, _ := arr(g.Get("events"))
	clis, _ := arr(g.Get("cli"))
	steps, _ := arr(g.Get("steps"))
	zones, _ := arr(g.Get("zones"))
	if len(zones) == 0 {
		t.Fatal("no zones")
	}
	prevLocal := time.Local
	defer func() { time.Local = prevLocal; i18n.SetLocale(nil) }()
	i18n.SetLocale(func() string { return "zh-CN" })
	for _, zv := range zones {
		z := obj(zv)
		tz := numStr(z.Get("tz"))
		t.Run(tz, func(t *testing.T) {
			loc, err := time.LoadLocation(tz)
			if err != nil {
				t.Fatal(err)
			}
			time.Local = loc
			now, _ := numOf(z.Get("now"))
			dir := t.TempDir()
			qdir := filepath.Join(dir, "quality")
			var dialogs []any
			next := ""
			svc := New(ServiceDeps{Dir: qdir, FlushMs: -1, Now: func() float64 { return now }, Cost: goldenCost, LabelOf: labelOf,
				SaveFile: func(title, def string, fs []deps.FileFilter) (string, error) {
					ff := []any{}
					for _, f := range fs {
						ex := []any{}
						for _, e := range f.Extensions {
							ex = append(ex, e)
						}
						ff = append(ff, u.NewObj("name", f.Name, "extensions", ex))
					}
					dialogs = append(dialogs, u.NewObj("title", title, "defaultPath", def, "filters", ff, "parent", "focused"))
					return next, nil
				}})
			defer svc.Dispose()
			added := []any{}
			for _, e := range evs {
				if r := svc.AddGateway(obj(e)); r != nil {
					added = append(added, r.Get("id"))
				} else {
					added = append(added, nil)
				}
			}
			for _, c := range clis {
				if r := svc.AddCli(obj(c)); r != nil {
					added = append(added, r.Get("id"))
				} else {
					added = append(added, nil)
				}
			}
			if a, b := norm(added), norm(z.Get("added")); a != b {
				t.Fatalf("added mismatch\n go: %.400s\nnode: %.400s", a, b)
			}
			files := func() any {
				o := u.NewObj()
				ents, _ := os.ReadDir(qdir)
				names := []string{}
				for _, e := range ents {
					names = append(names, e.Name())
				}
				sort.Strings(names)
				for _, n := range names {
					b, _ := os.ReadFile(filepath.Join(qdir, n))
					o.Set(n, string(b))
				}
				return o
			}
			want, _ := arr(z.Get("results"))
			for i, sv := range steps {
				st, _ := arr(sv)
				op := numStr(st[0])
				var arg any = u.Undefined
				if len(st) > 1 {
					arg = st[1]
				}
				var out any
				switch op {
				case "query":
					out = svc.Query(arg)
				case "facets":
					out = svc.Facets(arg)
				case "series":
					out, err = svc.Series(arg)
					if err != nil {
						t.Fatal(err)
					}
				case "requests":
					out = svc.Requests(arg)
				case "getSettings":
					out = svc.GetSettings()
				case "setSettings":
					out = svc.SetSettings(arg)
				case "clear":
					if err := svc.Clear(); err != nil {
						t.Fatal(err)
					}
					out = true
				case "files":
					out = files()
				case "export":
					dialogs = nil
					save, _ := st[2].(string)
					next = ""
					if save != "" {
						next = filepath.Join(dir, save)
					}
					res, err := svc.ExportCsv(arg)
					if err != nil {
						t.Fatal(err)
					}
					if res.Has("path") {
						res.Set("path", filepath.Base(numStr(res.Get("path"))))
					}
					var csv any
					if save != "" {
						b, _ := os.ReadFile(next)
						csv = string(b)
					}
					dl := []any{}
					dl = append(dl, dialogs...)
					out = u.NewObj("res", res, "dialog", dl, "csv", csv)
				}
				if a, b := norm(out), norm(want[i]); a != b {
					k := 0
					for k < len(a) && k < len(b) && a[k] == b[k] {
						k++
					}
					lo := k - 200
					if lo < 0 {
						lo = 0
					}
					t.Errorf("step %d %s %s mismatch at %d\n go: %.600s\nnode: %.600s", i, op, norm(arg), k, a[lo:], b[lo:])
				}
			}
		})
	}
}
