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

// TestWorkspaceFilesGolden 按 b7-ws-scenarios.json 重放 workspaceFiles，与 Node 录制逐条比对（mtimeMs 归一）。
func TestWorkspaceFilesGolden(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	p, _ := paritytest.Golden(t, "workspacefiles.json", filepath.Join("testdata", "workspacefiles.json"))
	g := readJSON(t, p).(*util.Obj)
	if pl := g.Get("platform").(string); pl != usage.Platform() {
		t.Skipf("golden recorded on %s", pl)
	}
	fx := readJSON(t, paritytest.RepoPath("scripts/parity/b7-ws-scenarios.json")).(*util.Obj)
	tmp, err := os.MkdirTemp("", "nomi-b7w-")
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
		b := []byte{} // Buffer.from(body, 'latin1')
		for _, r := range files.Get(rel).(string) {
			b = append(b, byte(r))
		}
		if err := os.WriteFile(fp, b, 0o644); err != nil {
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
	at := func(r string) string { return filepath.Join(SB, filepath.FromSlash(r)) }
	sub := func(v any) any {
		if s, ok := v.(string); ok {
			return strings.ReplaceAll(s, "$SB", SB)
		}
		return v
	}
	cases := []any{}
	jsrt.Run(func() {
		for _, s := range fx.Get("steps").([]any) {
			st := s.([]any)
			op, cwd := st[0].(string), sub(st[1]).(string)
			a := []any{}
			for _, x := range st[2:] {
				a = append(a, sub(x))
			}
			var out any
			switch op {
			case "git":
				args := []string{cwd}
				for _, x := range a {
					args = append(args, x.(string))
				}
				c := exec.Command("git", args...)
				c.Dir = at("w")
				_ = c.Run()
				continue
			case "resolve":
				r := ResolveInCwd(at(cwd), a[0].(string))
				if r.code != "" {
					out = util.NewObj("ok", false, "error", r.err, "code", r.code)
				} else {
					out = util.NewObj("ok", true, "abs", r.abs, "rel", r.rel)
				}
			case "read":
				out = ReadWorkspaceFile(at(cwd), a[0].(string))
			case "write":
				out = WriteWorkspaceFile(at(cwd), a[0].(string), a[1])
			case "delete":
				out = DeleteWorkspaceFile(at(cwd), a[0].(string))
			case "checkout":
				out = GitCheckoutWorkspaceFile(at(cwd), a[0].(string))
			case "tree":
				out = ListWorkspaceTree(at(cwd))
			}
			cases = append(cases, util.NewObj("step", st, "out", out))
		}
	})
	got := util.StringifyIndent(cases, " ")
	for _, form := range []string{strings.Trim(util.Stringify(SB), `"`), strings.ReplaceAll(SB, `\`, "/")} {
		got = strings.ReplaceAll(got, form, "<SB>")
	}
	got = regexp.MustCompile(`"mtimeMs": [0-9.e+]+`).ReplaceAllString(got, `"mtimeMs": "<T>"`)
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
