package usage

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 回放 scripts/parity/record-usage-statusline.mjs 的录制。

type slFile struct {
	Path string `json:"path"`
	Mode *int   `json:"mode"`
	Text string `json:"text"`
}

type statuslineGolden struct {
	Parse []struct {
		Raw       string  `json:"raw"`
		UpdatedAt float64 `json:"updatedAt"`
		Out       string  `json:"out"`
	} `json:"parse"`
	Snaps []struct {
		Name  string  `json:"name"`
		Text  string  `json:"text"`
		Mtime float64 `json:"mtime"`
		Out   string  `json:"out"`
	} `json:"snaps"`
	Scripts []struct {
		Root string `json:"root"`
		Out  string `json:"out"`
	} `json:"scripts"`
	Hooks []struct {
		Name      string            `json:"name"`
		Settings  *string           `json:"settings"`
		Mode      *int              `json:"mode"`
		Snapshot  bool              `json:"snapshot"`
		Platform  string            `json:"platform"`
		ConfigDir bool              `json:"configDir"`
		Env       map[string]string `json:"env"`
		Steps     []struct {
			Op   string   `json:"op"`
			Out  string   `json:"out"`
			Tree []slFile `json:"tree"`
		} `json:"steps"`
	} `json:"hooks"`
	StartNow float64 `json:"startNow"`
}

func readingOut(r *QuotaReading) string {
	if r == nil {
		return "null"
	}
	return util.Stringify(r.ToObj())
}

func TestStatuslineParity(t *testing.T) {
	path, _ := paritytest.Golden(t, "usage-statusline.json", "testdata/usage-statusline.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g statuslineGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Parse) == 0 || len(g.Hooks) == 0 {
		t.Fatal("empty golden")
	}
	for i, c := range g.Parse {
		if got := readingOut(ParseStatuslineRateLimits(c.Raw, c.UpdatedAt)); got != c.Out {
			t.Errorf("parse #%d %q:\n got %s\nwant %s", i, c.Raw, got, c.Out)
		}
	}
	// 快照
	sroot := filepath.Join(t.TempDir(), "snap")
	for _, c := range g.Snaps {
		f := filepath.Join(sroot, StatuslineSnapshotFile)
		switch c.Name {
		case "missing":
		case "dir":
			_ = os.Remove(f)
			if err := os.MkdirAll(f, 0o777); err != nil {
				t.Fatal(err)
			}
		default:
			_ = os.MkdirAll(sroot, 0o777)
			if err := os.WriteFile(f, []byte(c.Text), 0o666); err != nil {
				t.Fatal(err)
			}
			sec, frac := math.Modf(c.Mtime)
			mt := time.Unix(int64(sec), int64(math.Round(frac*1e9)))
			if err := os.Chtimes(f, mt, mt); err != nil {
				t.Fatal(err)
			}
		}
		if got := readingOut(ReadStatuslineSnapshot(sroot)); got != c.Out {
			t.Errorf("snapshot %s:\n got %s\nwant %s", c.Name, got, c.Out)
		}
	}
	// 脚本文本（filepath.Join 在 Windows 会改分隔符；录制端同平台）
	for _, c := range g.Scripts {
		if got := BuildStatuslineScript(filepath.FromSlash(c.Root)); got != c.Out {
			t.Errorf("script %q:\n got %q\nwant %q", c.Root, got, c.Out)
		}
	}
	// hook 场景
	T, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tj := util.Stringify(T)
	tj = tj[1 : len(tj)-1]
	norm := func(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, tj, "<T>"), T, "<T>") }
	tree := func(dir string) []slFile {
		out := []slFile{}
		var walk func(d string)
		walk = func(d string) {
			ents, err := os.ReadDir(d)
			if err != nil {
				return
			}
			names := make([]string, len(ents))
			for i, e := range ents {
				names[i] = e.Name()
			}
			sort.Slice(names, func(i, j int) bool { return CmpUTF16(names[i], names[j]) < 0 })
			for _, n := range names {
				p := filepath.Join(d, n)
				st, err := os.Stat(p)
				if err != nil {
					continue
				}
				rel, _ := filepath.Rel(T, p)
				if st.IsDir() {
					walk(p)
					continue
				}
				var mode *int
				if runtime.GOOS != "windows" {
					m := int(st.Mode().Perm())
					mode = &m
				}
				txt, _ := os.ReadFile(p)
				out = append(out, slFile{Path: norm(filepath.ToSlash(rel)), Mode: mode, Text: norm(string(txt))})
			}
		}
		walk(dir)
		return out
	}
	nowTick := g.StartNow
	for _, sc := range g.Hooks {
		base := filepath.Join(T, sc.Name)
		home := filepath.Join(base, "home")
		usageRoot := filepath.Join(base, "user data", "usage")
		if err := os.MkdirAll(home, 0o777); err != nil {
			t.Fatal(err)
		}
		env := util.NewObj()
		for k, v := range sc.Env {
			env.Set(k, strings.ReplaceAll(v, "<T>", T))
		}
		sfile := filepath.Join(home, ".claude", "settings.json")
		if sc.ConfigDir {
			sfile = filepath.Join(base, "cfg", "settings.json")
		}
		if sc.Settings != nil {
			_ = os.MkdirAll(filepath.Dir(sfile), 0o777)
			if err := os.WriteFile(sfile, []byte(*sc.Settings), 0o666); err != nil {
				t.Fatal(err)
			}
			if sc.Mode != nil {
				_ = os.Chmod(sfile, os.FileMode(*sc.Mode))
			}
		}
		if sc.Snapshot {
			_ = os.MkdirAll(usageRoot, 0o777)
			_ = os.WriteFile(filepath.Join(usageRoot, StatuslineSnapshotFile), []byte("{}"), 0o666)
		}
		platform := sc.Platform
		if platform == "" {
			platform = "linux"
		}
		d := HookDeps{Root: usageRoot, Home: home, Env: env, Platform: platform, Now: func() float64 { v := nowTick; nowTick++; return v }}
		res := func(h HookStatus, err error) string {
			if err != nil {
				return "throw:" + err.Error()
			}
			return util.Stringify(h.ToObj())
		}
		for si, st := range sc.Steps {
			out := "__undef__"
			switch st.Op {
			case "status":
				out = util.Stringify(HookStatusOf(d).ToObj())
			case "enable":
				out = res(EnableHook(d))
			case "disable":
				out = res(DisableHook(d))
			case "rm-orig":
				_ = os.Remove(filepath.Join(usageRoot, "claude-statusline.orig.json"))
			case "orig-garbage":
				_ = os.WriteFile(filepath.Join(usageRoot, "claude-statusline.orig.json"), []byte(`"str"`), 0o666)
			case "replace-foreign":
				_ = os.WriteFile(sfile, []byte(`{"statusLine":{"type":"command","command":"other"}}`), 0o666)
			case "strip-type":
				raw, _ := os.ReadFile(sfile)
				v, _ := util.ParseString(string(raw))
				o := v.(*util.Obj)
				o.Get("statusLine").(*util.Obj).Delete("type")
				_ = os.WriteFile(sfile, []byte(util.Stringify(o)), 0o666)
			default:
				t.Fatalf("unknown op %s", st.Op)
			}
			if norm(out) != st.Out {
				t.Errorf("%s step %d (%s):\n got %s\nwant %s", sc.Name, si, st.Op, norm(out), st.Out)
			}
			got := tree(base)
			gb, _ := json.Marshal(got)
			wb, _ := json.Marshal(st.Tree)
			if string(gb) != string(wb) {
				t.Errorf("%s step %d (%s) tree:\n got %s\nwant %s", sc.Name, si, st.Op, gb, wb)
			}
		}
	}
}
