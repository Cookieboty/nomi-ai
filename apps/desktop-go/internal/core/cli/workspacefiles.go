package cli

// workspacefiles.go = apps/desktop-electron/internal/core/src/cli/workspaceFiles.ts（会话工作区内的文本文件读写 / 删除 / git checkout / 文件树）。

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/launch"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// WorkspaceTextMax = TEXT_MAX。
const WorkspaceTextMax = 1_500_000

type wsResolved struct {
	abs, rel, err, code string
}

func wsInsideRel(rel string) bool {
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// ResolveInCwd = resolveInCwd（code != "" 表示失败）。
func ResolveInCwd(cwd, filePath string) wsResolved {
	root := resolveFrom(absOf("."), cwd)
	raw := util.JSTrim(filePath)
	if raw == "" || strings.ContainsRune(raw, 0) {
		return wsResolved{err: "invalid path", code: "invalid"}
	}
	abs := resolveFrom(root, raw)
	rel := pathRel(root, abs)
	if !wsInsideRel(rel) {
		return wsResolved{err: "path outside workspace", code: "outside"}
	}
	if runtime.GOOS == "windows" {
		rootN := strings.ToLower(strings.ReplaceAll(root, `\`, "/"))
		absN := strings.ToLower(strings.ReplaceAll(abs, `\`, "/"))
		pre := rootN
		if !strings.HasSuffix(pre, "/") {
			pre += "/"
		}
		if absN != rootN && !strings.HasPrefix(absN, pre) {
			return wsResolved{err: "path outside workspace", code: "outside"}
		}
	}
	if !insideRealRoot(root, abs) {
		return wsResolved{err: "path outside workspace", code: "outside"}
	}
	if rel == "" {
		rel = filepath.Base(abs)
	}
	return wsResolved{abs: abs, rel: rel}
}

func insideRealRoot(root, abs string) bool {
	realRoot, err := jsRealpath(root)
	if err != nil {
		return false
	}
	cur := abs
	for {
		if real, err := jsRealpath(cur); err == nil {
			rel := pathRel(realRoot, real)
			return rel == "" || wsInsideRel(rel)
		}
		up := filepath.Dir(cur)
		if up == cur {
			return false
		}
		cur = up
	}
}

func looksBinary(b []byte) bool {
	n := len(b)
	if n > 8000 {
		n = 8000
	}
	for i := 0; i < n; i++ {
		if b[i] == 0 {
			return true
		}
	}
	return false
}

func wsFail(r wsResolved) *util.Obj { return util.NewObj("ok", false, "error", r.err, "code", r.code) }

func wsAt(r wsResolved, kv ...any) *util.Obj {
	return util.NewObj(append([]any{"path", r.abs, "rel", r.rel}, kv...)...)
}

func wsIO(r wsResolved, err error, syscall, path string, dest ...string) *util.Obj {
	return prepend(util.NewObj("ok", false), wsAt(r, "error", launch.NodeErrMessage(err, syscall, path, dest...), "code", "io"))
}

func mtimeMs(st os.FileInfo) float64 {
	t := st.ModTime()
	return float64(float64(t.Unix())*1000) + float64(float64(t.Nanosecond())/1e6)
}

func prepend(first *util.Obj, rest *util.Obj) *util.Obj {
	for _, k := range rest.Keys() {
		first.Set(k, rest.Get(k))
	}
	return first
}

// ReadWorkspaceFile = readWorkspaceFile。
func ReadWorkspaceFile(cwd, filePath string) *util.Obj {
	r := ResolveInCwd(cwd, filePath)
	if r.code != "" {
		return wsFail(r)
	}
	if !existsPath(r.abs) {
		return prepend(util.NewObj("ok", false), wsAt(r, "error", "not found", "code", "not-found"))
	}
	st, err := os.Stat(r.abs)
	if err != nil {
		return wsIO(r, err, "stat", r.abs)
	}
	if st.IsDir() {
		return prepend(util.NewObj("ok", false), wsAt(r, "error", "is a directory", "code", "is-dir"))
	}
	if st.Size() > WorkspaceTextMax {
		return prepend(util.NewObj("ok", false), wsAt(r, "size", float64(st.Size()), "error", "file too large", "code", "too-large"))
	}
	buf, err := os.ReadFile(r.abs)
	if err != nil {
		return wsIO(r, err, "open", r.abs)
	}
	if looksBinary(buf) {
		return prepend(util.NewObj("ok", true), wsAt(r, "binary", true, "size", float64(st.Size()), "mtimeMs", mtimeMs(st), "content", ""))
	}
	content := charcontract.DecodeUTF8(buf)
	truncated := util.UTF16Len(content) > WorkspaceTextMax
	if truncated {
		content = clisdk.Slice0(content, WorkspaceTextMax)
	}
	return prepend(util.NewObj("ok", true), wsAt(r, "content", content, "truncated", truncated, "size", float64(st.Size()), "mtimeMs", mtimeMs(st)))
}

// WriteWorkspaceFile = writeWorkspaceFile（content 非字符串 → invalid）。
func WriteWorkspaceFile(cwd, filePath string, content any) *util.Obj {
	r := ResolveInCwd(cwd, filePath)
	if r.code != "" {
		return wsFail(r)
	}
	c, ok := content.(string)
	if !ok {
		return util.NewObj("ok", false, "error", "invalid content", "code", "invalid")
	}
	if len(c) > WorkspaceTextMax {
		return util.NewObj("ok", false, "error", "content too large", "code", "too-large")
	}
	if st, err := os.Stat(r.abs); err == nil && st.IsDir() {
		return prepend(util.NewObj("ok", false), wsAt(r, "error", "is a directory", "code", "is-dir"))
	}
	if err := os.MkdirAll(filepath.Dir(r.abs), 0o777); err != nil {
		return wsIO(r, err, "mkdir", filepath.Dir(r.abs))
	}
	tmp := r.abs + ".nomi-tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, []byte(c), 0o666); err != nil {
		return wsIO(r, err, "open", tmp)
	}
	if err := os.Rename(tmp, r.abs); err != nil {
		return wsIO(r, err, "rename", tmp, r.abs)
	}
	st, err := os.Stat(r.abs)
	if err != nil {
		return wsIO(r, err, "stat", r.abs)
	}
	return prepend(util.NewObj("ok", true), wsAt(r, "content", c, "size", float64(st.Size()), "mtimeMs", mtimeMs(st)))
}

// DeleteWorkspaceFile = deleteWorkspaceFile。
func DeleteWorkspaceFile(cwd, filePath string) *util.Obj {
	r := ResolveInCwd(cwd, filePath)
	if r.code != "" {
		return wsFail(r)
	}
	if !existsPath(r.abs) {
		return prepend(util.NewObj("ok", true), wsAt(r))
	}
	st, err := os.Stat(r.abs)
	if err != nil {
		return wsIO(r, err, "stat", r.abs)
	}
	if st.IsDir() {
		return prepend(util.NewObj("ok", false), wsAt(r, "error", "is a directory", "code", "is-dir"))
	}
	if err := os.Remove(r.abs); err != nil {
		return wsIO(r, err, "unlink", r.abs)
	}
	return prepend(util.NewObj("ok", true), wsAt(r))
}

// rawGit = execFile('git', args, {cwd, timeout, maxBuffer})（无 --no-pager 前缀，继承 process.env）。
func rawGit(cwd string, args []string, timeoutMs, maxBuf int) gitExecResult {
	jsrt.Leave()
	defer jsrt.Enter()
	return execFileGit(cwd, args, timeoutMs, "", maxBuf, usage.ProcessEnv(), false)
}

// GitCheckoutWorkspaceFile = gitCheckoutWorkspaceFile。
func GitCheckoutWorkspaceFile(cwd, filePath string) *util.Obj {
	r := ResolveInCwd(cwd, filePath)
	if r.code != "" {
		return wsFail(r)
	}
	root := resolveFrom(absOf("."), cwd)
	if !existsPath(filepath.Join(root, ".git")) {
		return prepend(util.NewObj("ok", false), wsAt(r, "error", "not a git repository", "code", "not-git"))
	}
	res := rawGit(root, []string{"checkout", "--", r.rel}, 30_000, 1024*1024)
	if res.err != "" {
		detail := util.JSTrim(res.rawStderr)
		if detail == "" {
			detail = res.err
		}
		return prepend(util.NewObj("ok", false), wsAt(r, "error", detail, "code", "io"))
	}
	return prepend(util.NewObj("ok", true), wsAt(r))
}

var (
	wsDepDirs   = map[string]bool{"node_modules": true, ".pnpm-store": true, "bower_components": true, "jspm_packages": true, ".venv": true, "venv": true, "__pycache__": true, "Pods": true}
	wsVcsDirs   = map[string]bool{".git": true, ".hg": true, ".svn": true}
	wsCacheDirs = map[string]bool{".nuxt": true, ".svelte-kit": true, ".turbo": true, ".cache": true, ".parcel-cache": true, ".vite": true, ".angular": true, ".expo": true, ".gradle": true, ".pytest_cache": true, ".mypy_cache": true, ".ruff_cache": true, ".tox": true, ".eslintcache": true}
	wsNextCache = regexp.MustCompile(`^\.next(-` + jsDot + `+)?$`)
	wsJunk      = map[string]bool{".DS_Store": true, "Thumbs.db": true, "desktop.ini": true}
)

func wsSkipDir(n string) bool {
	return wsDepDirs[n] || wsVcsDirs[n] || wsCacheDirs[n] || wsNextCache.MatchString(n)
}

func listGitIgnored(root string) map[string]bool {
	out := map[string]bool{}
	r := rawGit(root, []string{"ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"}, 30_000, 64*1024*1024)
	if r.err != "" {
		return out
	}
	for _, s := range strings.Split(r.Stdout, "\x00") {
		if s != "" {
			out[s] = true
		}
	}
	return out
}

func walkDisk(root string) (files, dirs []string) {
	level := []string{""}
	for len(level) > 0 {
		next := []string{}
		for _, relDir := range level {
			es, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(relDir)))
			if err != nil {
				continue
			}
			for _, e := range es {
				rel := e.Name()
				if relDir != "" {
					rel = relDir + "/" + e.Name()
				}
				t := e.Type()
				if t.IsDir() {
					if wsSkipDir(e.Name()) {
						continue
					}
					dirs = append(dirs, rel)
					next = append(next, rel)
				} else if t.IsRegular() && !wsJunk[e.Name()] {
					files = append(files, rel)
				}
			}
		}
		level = next
	}
	return
}

type wsDir struct {
	children *[]any
	ignored  bool
}

// buildTree = buildTree。
func buildTree(files, dirs []string, ignored map[string]bool) []any {
	roots := []any{}
	index := map[string]*wsDir{"": {children: &roots}}
	var ensure func(rel string) *wsDir
	ensure = func(rel string) *wsDir {
		if h, ok := index[rel]; ok {
			return h
		}
		cut := strings.LastIndex(rel, "/")
		pr := ""
		if cut >= 0 {
			pr = rel[:cut]
		}
		parent := ensure(pr)
		isIgn := parent.ignored || ignored[rel+"/"] || ignored[rel]
		children := []any{}
		node := util.NewObj("kind", "dir", "name", rel[cut+1:], "path", rel)
		if isIgn {
			node.Set("ignored", true)
		}
		e := &wsDir{children: &children, ignored: isIgn}
		node.Set("children", e.children)
		*parent.children = append(*parent.children, node)
		index[rel] = e
		return e
	}
	for _, d := range dirs {
		ensure(d)
	}
	for _, f := range files {
		cut := strings.LastIndex(f, "/")
		pr := ""
		if cut >= 0 {
			pr = f[:cut]
		}
		parent := ensure(pr)
		node := util.NewObj("kind", "file", "name", f[cut+1:], "path", f)
		if parent.ignored || ignored[f] {
			node.Set("ignored", true)
		}
		*parent.children = append(*parent.children, node)
	}
	c := collate.New(language.AmericanEnglish)
	var sortN func(ns []any) []any
	sortN = func(ns []any) []any {
		sort.SliceStable(ns, func(i, j int) bool {
			a, b := ns[i].(*util.Obj), ns[j].(*util.Obj)
			if a.Get("kind") != b.Get("kind") {
				return a.Get("kind") == "dir"
			}
			return c.CompareString(a.Get("name").(string), b.Get("name").(string)) < 0
		})
		for _, n := range ns {
			o := n.(*util.Obj)
			if ch, ok := o.Get("children").(*[]any); ok {
				o.Set("children", sortN(*ch))
			}
		}
		return ns
	}
	return sortN(roots)
}

// ListWorkspaceTree = listWorkspaceTree。
func ListWorkspaceTree(cwd string) *util.Obj {
	root := resolveFrom(absOf("."), cwd)
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return util.NewObj("ok", false, "error", "invalid cwd", "code", "invalid")
	}
	files, dirs := walkDisk(root)
	ign := listGitIgnored(root)
	return util.NewObj("ok", true, "entries", buildTree(files, dirs, ign))
}
