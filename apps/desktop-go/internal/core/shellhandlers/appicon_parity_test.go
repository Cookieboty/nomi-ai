package shellhandlers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/appicon"
)

type iconStep struct {
	Op      string          `json:"op"`
	Arg     *string         `json:"arg"`
	OK      json.RawMessage `json:"ok"`
	Applies []any           `json:"applies"`
}

// fakeIconTarget = record-shell.mjs 的 electron stub：win0 活着、win1 已销毁、托盘监听一个
type fakeIconTarget struct {
	assets  string
	applies []any
}

func (f *fakeIconTarget) rel(p string) string {
	r, _ := filepath.Rel(f.assets, p)
	return filepath.ToSlash(r)
}
func (f *fakeIconTarget) SetDockIcon(p string) {
	f.applies = append(f.applies, []any{"dock.setIcon", f.rel(p)})
}
func (f *fakeIconTarget) SetTrayIcon(p string) {
	f.applies = append(f.applies, []any{"tray", f.rel(p)})
}
func (f *fakeIconTarget) Windows() []appicon.Window {
	return []appicon.Window{&fakeIconWin{f, "win0", false}, &fakeIconWin{f, "win1", true}}
}

type fakeIconWin struct {
	f         *fakeIconTarget
	name      string
	destroyed bool
}

func (w *fakeIconWin) IsDestroyed() bool { return w.destroyed }
func (w *fakeIconWin) SetIcon(p string) {
	w.f.applies = append(w.f.applies, []any{w.name + ".setIcon", w.f.rel(p)})
}
func (w *fakeIconWin) SetAppDetails(id, p string, idx int) {
	w.f.applies = append(w.f.applies, []any{w.name + ".setAppDetails", map[string]any{"appId": id, "appIconPath": w.f.rel(p), "appIconIndex": idx}})
}

func TestAppIconParity(t *testing.T) {
	var g struct {
		Scenarios []struct {
			Platform string     `json:"platform"`
			Name     string     `json:"name"`
			File     *string    `json:"file"`
			Log      []iconStep `json:"log"`
		} `json:"scenarios"`
	}
	loadGolden(t, "shell_appicon.json", &g)
	assets, _ := filepath.Abs("../../../../../apps/desktop-electron/assets")
	if len(g.Scenarios) == 0 {
		t.Fatal("empty golden")
	}
	steps := 0
	for _, sc := range g.Scenarios {
		ud := t.TempDir()
		f := filepath.Join(ud, "app-icon.json")
		if sc.File != nil {
			if *sc.File == "dir" {
				os.Mkdir(f, 0o755)
			} else {
				os.WriteFile(f, []byte(*sc.File), 0o644)
			}
		}
		tg := &fakeIconTarget{assets: assets}
		svc := appicon.New(assets, assets, tg)
		svc.SetPlatform(sc.Platform)
		svc.Preview = func(p string, w int) string {
			return fmt.Sprintf(`preview:%s:{"width":%d}`, tg.rel(p), w)
		}
		svc.Init(f)
		for i, st := range sc.Log {
			if i > 0 {
				tg.applies = nil
			}
			var r any
			switch st.Op {
			case "init":
			case "get":
				r = svc.Get()
			case "set":
				r = svc.Set(*st.Arg)
			case "file":
				if fi, err := os.Stat(f); err == nil && !fi.IsDir() {
					b, _ := os.ReadFile(f)
					r = string(b)
				}
			}
			if st.Op != "init" {
				var want any
				json.Unmarshal(st.OK, &want)
				if got := normJSON(t, r, ud); !reflect.DeepEqual(got, want) {
					t.Errorf("%s/%s#%d %s: got %v want %v", sc.Platform, sc.Name, i, st.Op, got, want)
				}
			}
			ga := normJSON(t, tg.applies, ud)
			if ga == nil {
				ga = []any{}
			}
			if !reflect.DeepEqual(ga, normJSON(t, st.Applies, ud)) {
				t.Errorf("%s/%s#%d %s applies: got %v want %v", sc.Platform, sc.Name, i, st.Op, ga, st.Applies)
			}
			steps++
		}
	}
	t.Logf("appIcon parity: %d scenarios, %d steps", len(g.Scenarios), steps)
}
