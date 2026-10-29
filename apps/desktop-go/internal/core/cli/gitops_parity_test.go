package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

func readJSON(t *testing.T, p string) any {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// TestGitOpsGolden 在真实临时仓库上按 b7-git-scenarios.json 重放 gitOps，与 Node 录制逐条比对。
func TestGitOpsGolden(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	p, _ := paritytest.Golden(t, "gitops.json", filepath.Join("testdata", "gitops.json"))
	g := readJSON(t, p).(*util.Obj)
	if pl := g.Get("platform").(string); pl != usage.Platform() {
		t.Skipf("golden recorded on %s", pl)
	}
	steps := readJSON(t, filepath.Join("..", "..", "..", "..", "..", "scripts", "parity", "b7-git-scenarios.json")).([]any)

	tmp, err := os.MkdirTemp("", "nomi-b7g-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmp)
	SB := gitReal(tmp)
	if err := os.WriteFile(filepath.Join(SB, "gitconfig"), []byte("[user]\n\tname = T\n\temail = t@x\n[core]\n\tautocrlf = false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": filepath.Join(SB, "gitconfig"), "GIT_AUTHOR_DATE": "2020-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2020-01-01T00:00:00Z", "LANG": "C", "LC_ALL": "C"} {
		t.Setenv(k, v)
	}
	A := filepath.Join(SB, "a")
	vars := map[string]any{}
	var sub func(v any) any
	sub = func(v any) any {
		switch x := v.(type) {
		case string:
			switch x {
			case "$sha", "$stashes":
				return vars[x[1:]]
			case "$HEAD":
				out, _ := exec.Command("git", "-C", A, "rev-parse", "HEAD").Output()
				return strings.TrimSpace(string(out))
			}
			return strings.ReplaceAll(x, "$SB", SB)
		case []any:
			out := make([]any, len(x))
			for i, e := range x {
				out[i] = sub(e)
			}
			return out
		}
		return v
	}
	arg := func(a []any, i int) any {
		if i < len(a) {
			return a[i]
		}
		return nil
	}
	nullObj := func(o *util.Obj) any {
		if o == nil {
			return nil
		}
		return o
	}
	got := []any{}
	for i, s := range steps {
		st := s.(*util.Obj)
		if gv := st.Get("git"); gv != nil {
			args := []string{}
			for _, a := range sub(gv).([]any) {
				args = append(args, a.(string))
			}
			c := exec.Command("git", args...)
			c.Dir = A
			if st.Get("at") != nil {
				c.Dir = SB
			}
			if out, err := c.CombinedOutput(); err != nil {
				t.Fatalf("git %v: %v %s", args, err, out)
			}
			continue
		}
		if w := st.Get("write"); w != nil {
			wa := w.([]any)
			f := filepath.Join(A, filepath.FromSlash(wa[0].(string)))
			_ = os.MkdirAll(filepath.Dir(f), 0o755)
			if err := os.WriteFile(f, []byte(wa[1].(string)), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		op := st.Get("op").(string)
		a := []any{}
		if av := st.Get("args"); av != nil {
			a = sub(av).([]any)
		}
		var v any
		jsrt.Run(func() {
			switch op {
			case "syncStatus":
				v = nullObj(GitSyncStatus(A))
			case "worktrees":
				v = nullObj(GitWorktrees(A))
			case "owned":
				ws := []*util.Obj{}
				for _, w := range GitWorktrees(A).Get("worktrees").([]any) {
					ws = append(ws, w.(*util.Obj))
				}
				out := []any{}
				for _, p := range OwnedWorktrees(A, ws) {
					out = append(out, p)
				}
				v = out
			case "stage":
				v = GitStage(A, arg(a, 0))
			case "unstage":
				v = GitUnstage(A, arg(a, 0))
			case "commit":
				v = GitCommit(A, arg(a, 0), arg(a, 1))
			case "commitUndo":
				v = GitCommitUndo(A, arg(a, 0))
			case "fetch":
				v = GitFetch(A)
			case "pull":
				v = GitPull(A)
			case "push":
				v = GitPush(A)
			case "context":
				c := GitCommitContextOf(A, arg(a, 0))
				if c == nil {
					v = nil
				} else {
					sa := []any{}
					for _, s := range c.Subjects {
						sa = append(sa, s)
					}
					v = util.NewObj("subjects", sa, "stat", c.Stat, "diff", c.Diff, "truncated", c.Truncated)
				}
			case "discard":
				v = GitDiscard(A, arg(a, 0))
			case "discardUndo":
				v = GitDiscardUndo(A, arg(a, 0))
			default:
				t.Fatalf("op %s", op)
			}
		})
		if o, ok := v.(*util.Obj); ok {
			if s := o.Get("sha"); s != nil {
				vars["sha"] = s
			}
			if s := o.Get("stashes"); s != nil {
				vars["stashes"] = s
			}
		}
		got = append(got, util.NewObj("name", util.FormatNumber(float64(i))+":"+op, "out", util.NewObj("v", v)))
	}
	for _, s := range []string{"", "x", "https://u:p@h/x and ssh://me@host/y", "a://b@c@d"} {
		got = append(got, util.NewObj("name", "redact:"+s, "out", util.NewObj("v", Redact(s))))
	}
	for _, c := range []struct {
		n string
		r GitRun
	}{
		{"to", GitRun{-1, "", "Authentication failed", true}},
		{"auth", GitRun{1, "", "fatal: could not read Username", false}},
		{"div", GitRun{1, "hint: diverging branches", "", false}},
		{"dirty", GitRun{1, "", "Please COMMIT YOUR CHANGES OR STASH THEM", false}},
		{"rej", GitRun{1, "", " ! [rejected] main -> main (fetch first)", false}},
		{"err", GitRun{1, "", "boom", false}},
	} {
		got = append(got, util.NewObj("name", "classify:"+c.n, "out", util.NewObj("v", Classify(c.r))))
	}
	for _, raw := range []string{"", "worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b c\nHEAD def\ndetached\nlocked reason\nprunable gitdir\n\nworktree /bare\nbare\n", "HEAD x\n\nworktree /z\nbranch feature/x\n"} {
		ws := []any{}
		for _, w := range ParseWorktrees(raw) {
			ws = append(ws, w)
		}
		got = append(got, util.NewObj("name", "parse:"+util.Stringify(raw), "out", util.NewObj("v", ws)))
	}
	s := util.Stringify(got)
	esc := util.Stringify(SB)
	s = strings.ReplaceAll(s, esc[1:len(esc)-1], "<SB>")
	s = strings.ReplaceAll(s, strings.ReplaceAll(SB, `\`, "/"), "<SB>")
	s = regexp.MustCompile(`\b[0-9a-f]{7,64}\b`).ReplaceAllString(s, "<H>")
	want := util.Stringify(g.Get("cases"))
	if s != want {
		gv, _ := util.ParseString(s)
		ga, wa := gv.([]any), g.Get("cases").([]any)
		for i := range wa {
			if i >= len(ga) || util.Stringify(ga[i]) != util.Stringify(wa[i]) {
				var gi any
				if i < len(ga) {
					gi = ga[i]
				}
				t.Fatalf("case %d mismatch\n got: %s\nwant: %s", i, util.Stringify(gi), util.Stringify(wa[i]))
			}
		}
		t.Fatalf("len got %d want %d", len(ga), len(wa))
	}
}
