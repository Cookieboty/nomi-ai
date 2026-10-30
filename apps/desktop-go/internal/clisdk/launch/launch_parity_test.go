package launch

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// TestLaunchParity 回放 scripts/parity/record-b7-launch.mjs 录下的 Node 场景：逐步返回值 + 最终目录树。
func TestLaunchParity(t *testing.T) {
	gp, live := paritytest.Golden(t, "launch.json", "testdata/launch.json")
	if !live && runtime.GOOS == "windows" {
		t.Log("committed golden is POSIX; Windows compares against the live CI recording (NOMI_LIVE_GOLDENS)")
		return
	}
	raw, err := os.ReadFile(gp)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.ParseString(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer setUmask(0o022)()
	for _, sc := range v.([]any) {
		sco := sc.(*util.Obj)
		name := sco.Get("name").(string)
		t.Run(name, func(t *testing.T) {
			S, err := realpathNative(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			sub := func(x any) string { return strings.ReplaceAll(x.(string), "$S", S) }
			results := []any{}
			for _, op := range sco.Get("ops").([]any) {
				o := op.(*util.Obj)
				var r any
				switch o.Get("op").(string) {
				case "mkdir":
					_ = os.MkdirAll(sub(o.Get("path")), 0o777)
				case "write":
					_ = os.WriteFile(sub(o.Get("path")), []byte(o.Get("content").(string)), 0o666)
				case "symlink":
					_ = os.Symlink(sub(o.Get("target")), sub(o.Get("path")))
				case "applyLaunchEnv":
					strip := []string{}
					for _, s := range o.Get("strip").([]any) {
						strip = append(strip, s.(string))
					}
					r = ApplyLaunchEnv(o.Get("base").(*util.Obj), o.Get("env").(*util.Obj), strip)
				case "writeLaunchFiles":
					files := []File{}
					for _, f := range o.Get("files").([]any) {
						fo := f.(*util.Obj)
						lf := File{Path: sub(fo.Get("path")), Content: fo.Get("content").(string)}
						if m, ok := fo.Get("mode").(float64); ok {
							mm := os.FileMode(int(m))
							lf.Mode = &mm
						}
						files = append(files, lf)
					}
					w, err := WriteLaunchFiles(files)
					if err != nil {
						r = util.NewObj("throw", err.Error())
					} else {
						r = strsAny(w)
					}
				case "canonicalDir":
					r = CanonicalDir(sub(o.Get("p")))
				case "linkShared":
					if s := LinkShared(sub(o.Get("target")), sub(o.Get("link")), o.Get("dir").(bool), nodePlatform()); s != "" {
						r = s
					}
				case "ensureSharedHome":
					ents := []clisdk.SharedEntry{}
					for _, e := range o.Get("entries").([]any) {
						eo := e.(*util.Obj)
						c, _ := eo.Get("createIfMissing").(bool)
						ents = append(ents, clisdk.SharedEntry{Name: eo.Get("name").(string), Dir: eo.Get("dir").(bool), CreateIfMissing: c})
					}
					r = problemsOut(EnsureSharedHome(sub(o.Get("dir")), sub(o.Get("userDir")), ents, nodePlatform()))
				case "ensurePrivateHome":
					keep := []string{}
					for _, k := range o.Get("keepPrivate").([]any) {
						keep = append(keep, k.(string))
					}
					r = problemsOut(EnsurePrivateHome(sub(o.Get("dir")), sub(o.Get("userDir")), o.Get("shared").(string), keep, nodePlatform()))
				}
				if s, ok := r.(string); ok {
					r = strings.ReplaceAll(s, S, "$S")
				}
				if l, ok := r.([]any); ok {
					for i, x := range l {
						if s, ok := x.(string); ok {
							l[i] = strings.ReplaceAll(s, S, "$S")
						}
					}
				}
				results = append(results, r)
			}
			if g, w := util.Stringify(results), util.Stringify(sco.Get("results")); g != w {
				t.Errorf("results\n got  %s\n want %s", g, w)
			}
			if g, w := util.Stringify(snapshot(S)), util.Stringify(sco.Get("tree")); g != w {
				t.Errorf("tree\n got  %s\n want %s", g, w)
			}
		})
	}
}

// nodePlatform = process.platform。
func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func strsAny(l []string) []any {
	out := []any{}
	for _, s := range l {
		out = append(out, s)
	}
	return out
}

func problemsOut(ps []LinkProblem, err error) any {
	if err != nil {
		return util.NewObj("throw", err.Error())
	}
	out := []any{}
	for _, p := range ps {
		out = append(out, util.NewObj("entry", p.Entry, "reason", p.Reason))
	}
	return out
}

func snapshot(S string) []any {
	out := []any{}
	var walk func(d string)
	walk = func(d string) {
		f, _ := os.Open(d)
		names, _ := f.Readdirnames(-1)
		f.Close()
		sort.Strings(names)
		for _, n := range names {
			p := filepath.Join(d, n)
			st, _ := os.Lstat(p)
			rel := "$S" + filepath.ToSlash(p[len(S):])
			switch {
			case isLink(st):
				to, _ := readlinkNode(p)
				out = append(out, util.NewObj("p", rel, "t", "l", "to", strings.ReplaceAll(to, S, "$S")))
			case st.IsDir():
				out = append(out, util.NewObj("p", rel, "t", "d", "m", nodeStatMode(st)))
				walk(p)
			default:
				c, _ := os.ReadFile(p)
				out = append(out, util.NewObj("p", rel, "t", "f", "m", nodeStatMode(st), "c", string(c)))
			}
		}
	}
	walk(S)
	return out
}
