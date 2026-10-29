package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// TestSlashDiscoveryGolden 用 b7-slash-fixture.json 建同一棵临时树，重放 discover/expand/纯函数/git，与 Node 逐条比对。
func TestSlashDiscoveryGolden(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	p, _ := paritytest.Golden(t, "slashdiscovery.json", filepath.Join("testdata", "slashdiscovery.json"))
	g := readJSON(t, p).(*util.Obj)
	if pl := g.Get("platform").(string); pl != usage.Platform() {
		t.Skipf("golden recorded on %s", pl)
	}
	fx := readJSON(t, filepath.Join("..", "..", "..", "..", "..", "scripts", "parity", "b7-slash-fixture.json")).(*util.Obj)
	tmp, err := os.MkdirTemp("", "nomi-b7s-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmp)
	SB := gitReal(tmp)
	_ = os.WriteFile(filepath.Join(SB, "gitconfig"), []byte("[user]\n\tname = T\n\temail = t@x\n[core]\n\tautocrlf = false\n"), 0o644)
	for k, v := range map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": filepath.Join(SB, "gitconfig"), "GIT_AUTHOR_DATE": "2020-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2020-01-01T00:00:00Z", "LANG": "C", "LC_ALL": "C"} {
		t.Setenv(k, v)
	}
	files := fx.Get("files").(*util.Obj)
	for _, rel := range files.Keys() {
		fp := filepath.Join(SB, filepath.FromSlash(rel))
		_ = os.MkdirAll(filepath.Dir(fp), 0o755)
		if err := os.WriteFile(fp, []byte(files.Get(rel).(string)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if runtime.GOOS != "windows" {
		for _, l := range fx.Get("links").([]any) {
			a := l.([]any)
			if err := os.Symlink(a[0].(string), filepath.Join(SB, filepath.FromSlash(a[1].(string)))); err != nil {
				t.Fatal(err)
			}
		}
	}
	HOME := filepath.Join(SB, "home")
	at := func(rel any) string { return filepath.Join(SB, filepath.FromSlash(rel.(string))) }
	strs := func(v any) []string {
		out := []string{}
		for _, x := range v.([]any) {
			out = append(out, x.(string))
		}
		return out
	}
	cases := []any{}
	add := func(op string, args []any, out any) {
		cases = append(cases, util.NewObj("op", op, "args", args, "out", out))
	}
	jsrt.Run(func() {
		for _, a := range fx.Get("discover").([]any) {
			x := a.([]any)
			add("discover", x, DiscoverSlash(x[0].(string), at(x[1]), HOME))
		}
		for _, a := range fx.Get("expand").([]any) {
			x := a.([]any)
			var out any
			if r := ExpandSlash(x[0].(string), at(x[1]), x[2].(string), x[3].(string), HOME); r != nil {
				out = r
			}
			add("expand", x, out)
		}
		for _, a := range fx.Get("frontmatter").([]any) {
			m, b := ParseFrontmatter(a.(string))
			add("frontmatter", []any{a}, util.NewObj("meta", m, "body", b))
		}
		for _, a := range fx.Get("splitArgs").([]any) {
			r := []any{}
			for _, s := range SplitArgs(a.(string)) {
				r = append(r, s)
			}
			add("splitArgs", []any{a}, r)
		}
		for _, a := range fx.Get("template").([]any) {
			x := a.([]any)
			txt, c := ExpandTemplate(x[0].(string), x[1].(string), strs(x[2]))
			add("template", x, util.NewObj("text", txt, "consumed", c))
		}
		for _, a := range fx.Get("numstat").([]any) {
			add("numstat", []any{a}, ParseNumstat(a.(string)))
		}
		R := filepath.Join(SB, "repo")
		_ = os.Mkdir(R, 0o755)
		probe := func(name, dir string) {
			var b any
			if r := GitBranch(dir); r != nil {
				b = r
			}
			add("branch", []any{name}, b)
			add("diff", []any{name}, GitDiff(dir))
		}
		probe("proj", at("proj"))
		probe("outside", at("outside"))
		for _, a := range fx.Get("git").([]any) {
			st := strs(a)
			switch st[0] {
			case "write":
				_ = os.WriteFile(filepath.Join(R, st[1]), []byte(st[2]), 0o644)
			case "probe":
				probe("repo", R)
			default:
				args := st
				if st[0] == "git" {
					args = st[1:]
				}
				c := exec.Command("git", args...)
				c.Dir = R
				_ = c.Run()
			}
		}
	})
	got := util.StringifyIndent(cases, " ")
	for _, form := range []string{strings.Trim(util.Stringify(SB), `"`), strings.ReplaceAll(SB, `\`, "/")} {
		got = strings.ReplaceAll(got, form, "<SB>")
	}
	got = regexp.MustCompile(`\b[0-9a-f]{7,64}\b`).ReplaceAllString(got, "<H>")
	want := util.StringifyIndent(g.Get("cases"), " ")
	if got != want {
		gl, wl := strings.Split(got, "\n"), strings.Split(want, "\n")
		for i := 0; i < len(gl) && i < len(wl); i++ {
			if gl[i] != wl[i] {
				t.Fatalf("mismatch at line %d:\n got: %s\nwant: %s\ncontext: %s", i+1, gl[i], wl[i], strings.Join(wl[max(0, i-8):i], "\n"))
			}
		}
		t.Fatalf("length mismatch %d vs %d", len(gl), len(wl))
	}
}
