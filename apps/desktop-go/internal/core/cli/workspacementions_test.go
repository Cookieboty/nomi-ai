package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func mentionPathsOf(r *util.Obj) map[string]string {
	out := map[string]string{}
	entries, _ := r.Get("entries").([]any)
	for _, e := range entries {
		o := e.(*util.Obj)
		path, _ := o.Get("path").(string)
		kind, _ := o.Get("kind").(string)
		out[path] = kind
	}
	return out
}

func collectTreePaths(nodes []any, out map[string]string) {
	for _, n := range nodes {
		o := n.(*util.Obj)
		path, _ := o.Get("path").(string)
		kind, _ := o.Get("kind").(string)
		out[path] = kind
		if ch, ok := o.Get("children").([]any); ok {
			collectTreePaths(ch, out)
		} else if chp, ok := o.Get("children").(*[]any); ok && chp != nil {
			collectTreePaths(*chp, out)
		}
	}
}

func skipTreePath(p string) bool {
	return p == "node_modules" || strings.HasPrefix(p, "node_modules/") ||
		p == ".venv" || strings.HasPrefix(p, ".venv/") ||
		p == ".next" || strings.HasPrefix(p, ".next/") ||
		isGitPath(p)
}

func isGitPath(p string) bool {
	return p == ".git" || strings.HasPrefix(p, ".git/")
}

func TestWorkspaceMentionPathsIncludesSkipDirs(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	dir := gitReal(t.TempDir())
	if err := os.WriteFile(filepath.Join(dir, "gitconfig"), []byte("[user]\n\tname = T\n\temail = t@x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(dir, "gitconfig"))

	write := func(rel, body string) {
		t.Helper()
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("README.md", "visible")
	write("src/app.ts", "export {}\n")
	write("secret.txt", "ignored")
	write("node_modules/pkg/index.js", "module.exports = 1\n")
	write(".venv/lib/x.py", "x = 1\n")
	write(".next/cache/x", "cache")
	write(".gitignore", "secret.txt\nnode_modules/\n.venv/\n.next/\n")

	git := func(args ...string) {
		t.Helper()
		c := exec.Command("git", args...)
		c.Dir = dir
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	git("add", "README.md", "src/app.ts", ".gitignore")
	git("commit", "-q", "-m", "init")
	write(".git/objects/dummy-mention", "not-a-git-object")

	run := func(fn func() *util.Obj) *util.Obj {
		var r *util.Obj
		jsrt.Run(func() { r = fn() })
		return r
	}

	tree := run(func() *util.Obj { return ListWorkspaceTree(dir) })
	if tree.Get("ok") != true {
		t.Fatalf("tree: %v", tree)
	}
	treePaths := map[string]string{}
	entries, _ := tree.Get("entries").([]any)
	collectTreePaths(entries, treePaths)
	if _, ok := treePaths["README.md"]; !ok {
		t.Fatalf("tree missing README.md: %v", treePaths)
	}
	if _, ok := treePaths["secret.txt"]; !ok {
		t.Fatalf("tree should list gitignored secret.txt: %v", treePaths)
	}
	if _, ok := treePaths["src/app.ts"]; !ok {
		t.Fatalf("tree missing src/app.ts: %v", treePaths)
	}
	for p := range treePaths {
		if skipTreePath(p) {
			t.Fatalf("tree should omit skipped dir contents, got %q", p)
		}
	}

	empty := run(func() *util.Obj { return ListWorkspaceMentionPaths(dir, "", 50) })
	if empty.Get("ok") != true {
		t.Fatalf("empty mention: %v", empty)
	}
	tops := mentionPathsOf(empty)
	for _, p := range []string{"node_modules", ".venv", ".next"} {
		if tops[p] != "dir" {
			t.Fatalf("empty query should include %s dir top, got %v", p, tops)
		}
	}
	if _, ok := tops["node_modules/pkg/index.js"]; ok {
		t.Fatalf("empty query should not walk skip-dir internals: %v", tops)
	}
	if _, ok := tops["README.md"]; ok {
		t.Fatalf("mention query should not dump the visible tree: %v", tops)
	}
	for p := range tops {
		if isGitPath(p) {
			t.Fatalf("mention must not return .git internals: %q", p)
		}
	}

	idx := mentionPathsOf(run(func() *util.Obj { return ListWorkspaceMentionPaths(dir, "index", 50) }))
	if idx["node_modules/pkg/index.js"] != "file" {
		t.Fatalf("query index should find node_modules/pkg/index.js, got %v", idx)
	}
	if idx["node_modules"] != "" && idx["node_modules"] != "dir" {
		t.Fatalf("unexpected node_modules kind: %v", idx)
	}

	venv := mentionPathsOf(run(func() *util.Obj { return ListWorkspaceMentionPaths(dir, "x.py", 50) }))
	if venv[".venv/lib/x.py"] != "file" {
		t.Fatalf("query x.py should find .venv/lib/x.py, got %v", venv)
	}

	next := mentionPathsOf(run(func() *util.Obj { return ListWorkspaceMentionPaths(dir, "next", 50) }))
	if next[".next"] != "dir" {
		t.Fatalf("query next should find .next dir, got %v", next)
	}

	gitQ := mentionPathsOf(run(func() *util.Obj { return ListWorkspaceMentionPaths(dir, "dummy-mention", 50) }))
	for p := range gitQ {
		if isGitPath(p) || strings.Contains(p, "dummy-mention") {
			t.Fatalf("mention must not return .git internals, got %q in %v", p, gitQ)
		}
	}

	bad := run(func() *util.Obj { return ListWorkspaceMentionPaths(filepath.Join(dir, "missing"), "", 50) })
	if bad.Get("ok") != false || bad.Get("code") != "invalid" {
		t.Fatalf("missing cwd: %v", bad)
	}
}
