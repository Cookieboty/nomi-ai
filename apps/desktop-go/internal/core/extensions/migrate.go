package extensions

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/pelletier/go-toml/v2"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type McpCandidate struct {
	Key      string          `json:"key"`
	Kind     string          `json:"kind"`
	Tool     string          `json:"tool"`
	Scope    string          `json:"scope"`
	Name     string          `json:"name"`
	Where    string          `json:"where"`
	Warnings []string        `json:"warnings"`
	Server   *McpServerEntry `json:"server,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type SkillCandidate struct {
	Key         string   `json:"key"`
	Kind        string   `json:"kind"`
	Tool        string   `json:"tool"`
	Scope       string   `json:"scope"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Where       string   `json:"where"`
	Dir         string   `json:"dir"`
	Files       []string `json:"files"`
	Bytes       int64    `json:"bytes"`
	Normalize   bool     `json:"normalize"`
	Body        string   `json:"body"`
	Warnings    []string `json:"warnings"`
	Error       string   `json:"error,omitempty"`
}

type MigrateSource struct {
	Tool  string `json:"tool"`
	Where string `json:"where"`
	Found bool   `json:"found"`
	Error string `json:"error,omitempty"`
}

type MigrateScan struct {
	Mcp     []*McpCandidate   `json:"mcp"`
	Skills  []*SkillCandidate `json:"skills"`
	Sources []MigrateSource   `json:"sources"`
}

type MigrateEnv struct {
	Home       string
	Env        map[string]string
	ProjectDir string
}

const (
	maxClaudeJSON = 32 * 1024 * 1024
	maxConfig     = 1024 * 1024
	maxSkillMd    = 256 * 1024
	MaxSkillBytes = 5 * 1024 * 1024
	maxFiles      = 200
	maxEntries    = 200
)

func normSlash(p string) string { return strings.ReplaceAll(p, "\\", "/") }

func isWithin(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

func realOrEmpty(p string) string {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return ""
	}
	a, _ := filepath.Abs(r)
	return a
}

type readResult struct {
	Text    string
	Missing bool
	Err     string
}

func sameFile(a, b os.FileInfo) bool {
	sa, ok1 := a.Sys().(*syscall.Stat_t)
	sb, ok2 := b.Sys().(*syscall.Stat_t)
	if !ok1 || !ok2 {
		return os.SameFile(a, b)
	}
	return sa.Ino == sb.Ino && sa.Dev == sb.Dev
}

// ReadConfigFile：真实路径在 allowRoots 内、文件名不变、不在凭据目录；打开后再校验是同一文件
func ReadConfigFile(file string, maxBytes int64, allowRoots []string) readResult {
	if _, err := os.Lstat(file); err != nil {
		return readResult{Missing: true}
	}
	real := realOrEmpty(file)
	if real == "" {
		return readResult{Err: "ENOENT: no such file or directory, realpath '" + file + "'"}
	}
	skip := T("electron.common.skipped-a-symbolic-link-points-somewhere-that-may")
	if filepath.Base(real) != filepath.Base(file) || DenyDir.MatchString(normSlash(real)) {
		return readResult{Err: skip}
	}
	ok := false
	for _, r := range allowRoots {
		if rr := realOrEmpty(r); rr != "" && isWithin(rr, real) {
			ok = true
			break
		}
	}
	if !ok {
		return readResult{Err: skip}
	}
	f, err := os.Open(real)
	if err != nil {
		return readResult{Err: deps.Slice0(err.Error(), 200)}
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return readResult{Err: deps.Slice0(err.Error(), 200)}
	}
	if !st.Mode().IsRegular() {
		return readResult{Err: T("electron.common.skipped-not-a-regular-file")}
	}
	if st.Size() > maxBytes {
		return readResult{Err: T("electron.common.skipped-file-too-large")}
	}
	again, err := os.Stat(real)
	if err != nil || !sameFile(again, st) || realOrEmpty(real) != real {
		return readResult{Err: T("electron.common.skipped-the-file-changed-while-being-read")}
	}
	b, err := io.ReadAll(io.LimitReader(f, st.Size()))
	if err != nil {
		return readResult{Err: deps.Slice0(err.Error(), 200)}
	}
	return readResult{Text: strings.ToValidUTF8(string(b), "\uFFFD")}
}

var varRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}`)

func collectStrings(o any, out []string) []string {
	switch x := o.(type) {
	case string:
		out = append(out, x)
	case []any:
		for _, e := range x {
			out = collectStrings(e, out)
		}
	case *deps.OrderedObject:
		for _, k := range x.Keys {
			out = collectStrings(x.Values[k], out)
		}
	case map[string]any:
		ks := make([]string, 0, len(x))
		for k := range x {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			out = collectStrings(x[k], out)
		}
	}
	return out
}

func varWarnings(raw map[string]any) []string {
	seen := map[string]bool{}
	vars := []string{}
	for _, s := range collectStrings([]any{raw["command"], raw["args"], raw["url"], raw["env"], raw["headers"]}, nil) {
		for _, m := range varRef.FindAllStringSubmatch(s, -1) {
			if !seen[m[1]] {
				seen[m[1]] = true
				vars = append(vars, m[1])
			}
		}
	}
	if len(vars) == 0 {
		return nil
	}
	refs := make([]string, len(vars))
	for i, v := range vars {
		refs[i] = "${" + v + "}"
	}
	return []string{T("electron.common.contains-environment-variable-references-nomi-does-not-expand", strings.Join(refs, "、"))}
}

type conv struct {
	Raw      map[string]any
	Warnings []string
	Error    string
	Disabled bool
}

func asObj(v any) (map[string]any, bool) {
	switch x := v.(type) {
	case *deps.OrderedObject:
		return x.Map(), true
	case map[string]any:
		return x, true
	}
	return nil, false
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case int64:
		return x != 0
	}
	return true
}

func FromClaudeEntry(name string, v any) conv {
	o, ok := asObj(v)
	if !ok {
		return conv{Warnings: []string{}, Error: T("electron.common.invalid-configuration")}
	}
	w := []string{}
	typ := ""
	if s, ok := o["type"].(string); ok {
		typ = strings.ToLower(s)
	}
	_, hasType := o["type"].(string)
	var transport string
	switch {
	case typ == "ws" || typ == "sdk":
		return conv{Warnings: w, Error: T("electron.common.nomi-doesn-t-support-mcp-servers-yet", typ)}
	case typ == "sse":
		transport = "sse"
	case typ == "http" || typ == "streamable-http":
		transport = "http"
	case typ == "stdio":
		transport = "stdio"
	case hasType && typ != "":
		return conv{Warnings: w, Error: T("electron.common.unknown-type", typ)}
	default:
		if _, ok := o["url"].(string); ok {
			transport = "http"
			w = append(w, T("electron.common.no-type-given-imported-as-remote-http"))
		} else {
			transport = "stdio"
		}
	}
	if truthy(o["headersHelper"]) {
		w = append(w, T("electron.common.headershelper-dynamic-headers-is-not-imported-fill-in"))
	}
	if truthy(o["oauth"]) {
		w = append(w, T("electron.common.the-original-config-signs-in-with-oauth-nomi"))
	}
	var raw map[string]any
	if transport == "stdio" {
		raw = map[string]any{"name": name, "transport": transport, "command": o["command"], "args": o["args"], "env": o["env"]}
	} else {
		raw = map[string]any{"name": name, "transport": transport, "url": o["url"], "headers": o["headers"]}
	}
	w = append(w, varWarnings(raw)...)
	return conv{Raw: raw, Warnings: w}
}

func FromCodexEntry(name string, v any) conv {
	o, ok := asObj(v)
	if !ok {
		return conv{Warnings: []string{}, Error: T("electron.common.invalid-configuration")}
	}
	w := []string{}
	_, http := o["url"].(string)
	if http {
		if s, ok := o["bearer_token_env_var"].(string); ok {
			w = append(w, T("electron.common.the-token-comes-from-the-environment-variable-which", s))
		}
		if h, ok := o["env_http_headers"].(map[string]any); ok {
			ks := make([]string, 0, len(h))
			for k := range h {
				ks = append(ks, k)
			}
			sort.Strings(ks)
			w = append(w, T("electron.common.these-header-values-come-from-environment-variables-and", strings.Join(ks, "、")))
		}
		if truthy(o["http_headers_helper"]) {
			w = append(w, T("electron.common.http-headers-helper-dynamic-headers-is-not-imported"))
		}
	} else {
		if arr, ok := o["env_vars"].([]any); ok && len(arr) > 0 {
			names := []string{}
			for _, x := range arr {
				n := ""
				if s, ok := x.(string); ok {
					n = s
				} else if m, ok := x.(map[string]any); ok && m["name"] != nil {
					n = deps.JSString(m["name"])
				}
				if n != "" {
					names = append(names, n)
				}
			}
			w = append(w, T("electron.common.the-original-config-forwards-these-environment-variables-nomi", strings.Join(names, "、")))
		}
		if _, ok := o["cwd"].(string); ok {
			w = append(w, T("electron.common.nomi-doesn-t-support-a-working-directory-cwd"))
		}
	}
	if truthy(o["oauth"]) || o["auth"] == "oauth" {
		w = append(w, T("electron.common.the-original-config-signs-in-with-oauth-nomi"))
	}
	var raw map[string]any
	if http {
		tr := "http"
		if sseRe.MatchString(deps.JSString(o["url"])) {
			tr = "sse"
		}
		raw = map[string]any{"name": name, "transport": tr, "url": o["url"], "headers": o["http_headers"]}
	} else {
		raw = map[string]any{"name": name, "transport": "stdio", "command": o["command"], "args": o["args"], "env": o["env"]}
	}
	return conv{Raw: raw, Warnings: w, Disabled: o["enabled"] == false}
}

func sourceID(file string) string {
	a, _ := filepath.Abs(file)
	h := sha256.Sum256([]byte(a))
	return hex.EncodeToString(h[:])[:10]
}

func toCandidate(tool, scope, where, name string, c conv, src, keySuffix string) *McpCandidate {
	cd := &McpCandidate{Key: tool + ":" + scope + ":mcp:" + src + ":" + keySuffix + name, Kind: "mcp", Tool: tool, Scope: scope, Name: name, Where: where, Warnings: c.Warnings}
	if cd.Warnings == nil {
		cd.Warnings = []string{}
	}
	if c.Error != "" || c.Raw == nil {
		cd.Error = c.Error
		if cd.Error == "" {
			cd.Error = T("electron.common.invalid-configuration")
		}
		return cd
	}
	raw := map[string]any{}
	for k, v := range c.Raw {
		raw[k] = toJSONish(v)
	}
	raw["origin"], raw["trust"] = "user", "ask"
	s, err := SanitizeServer(raw, map[string]bool{})
	if err != nil {
		cd.Error = err.Error()
		return cd
	}
	if c.Disabled {
		cd.Warnings = append(cd.Warnings, T("electron.common.disabled-in-the-original-config"))
	}
	cd.Server = &s
	return cd
}

// toJSONish：TOML 解码出的 int64 等转成 JSON.parse 会给出的类型
func toJSONish(v any) any {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case []any:
		r := make([]any, len(x))
		for i, e := range x {
			r[i] = toJSONish(e)
		}
		return r
	case map[string]any:
		r := map[string]any{}
		for k, e := range x {
			r[k] = toJSONish(e)
		}
		return r
	case *deps.OrderedObject:
		return toJSONish(x.Map())
	}
	return v
}

func claudeServers(servers any, tool, scope, where, src, keySuffix string) []*McpCandidate {
	o, ok := servers.(*deps.OrderedObject)
	if !ok {
		return nil
	}
	out := []*McpCandidate{}
	for i, name := range o.Keys {
		if i >= maxEntries {
			break
		}
		out = append(out, toCandidate(tool, scope, where, name, FromClaudeEntry(name, o.Values[name]), src, keySuffix))
	}
	return out
}

func display(home, p, project string) string {
	if project != "" {
		if r, err := filepath.Rel(project, p); err == nil && r != "." && !strings.HasPrefix(r, "..") && !filepath.IsAbs(r) {
			return filepath.Base(project) + "/" + normSlash(r)
		}
	}
	if h, err := filepath.Rel(home, p); err == nil && h != "." && !strings.HasPrefix(h, "..") && !filepath.IsAbs(h) {
		return "~/" + normSlash(h)
	}
	return normSlash(p)
}

var und = collate.New(language.Und)

func sortedEntries(dir string) ([]os.DirEntry, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(ents, func(i, j int) bool { return und.CompareString(ents[i].Name(), ents[j].Name()) < 0 })
	return ents, nil
}

type walkResult struct {
	files, denied []string
	links         int
	truncated     bool
}

func walkSkill(root string) walkResult {
	w := walkResult{files: []string{}, denied: []string{}}
	var rec func(rel string, depth int)
	rec = func(rel string, depth int) {
		if depth > 4 {
			return
		}
		ents, err := sortedEntries(filepath.Join(root, rel))
		if err != nil {
			return
		}
		for _, e := range ents {
			if len(w.files) >= maxFiles {
				w.truncated = true
				return
			}
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			r := e.Name()
			if rel != "" {
				r = rel + "/" + e.Name()
			}
			switch {
			case e.Type()&os.ModeSymlink != 0:
				w.links++
			case e.IsDir():
				rec(r, depth+1)
			case e.Type().IsRegular():
				if Deny.MatchString(r) || Deny.MatchString(e.Name()) {
					w.denied = append(w.denied, r)
				} else {
					w.files = append(w.files, r)
				}
			}
		}
	}
	rec("", 0)
	return w
}

var nsBad = regexp.MustCompile(`[^a-z0-9-]+`)
var nsDash = regexp.MustCompile(`-+`)
var nsEdge = regexp.MustCompile(`^-+|-+$`)

func NomiSkillName(raw string) string {
	s := nsEdge.ReplaceAllString(nsDash.ReplaceAllString(nsBad.ReplaceAllString(strings.ToLower(raw), "-"), "-"), "")
	return deps.Slice0(s, 64)
}

var hashPrefix = regexp.MustCompile(`^#+\s*`)

func firstLine(body string) string {
	for _, l := range lineSplit.Split(body, -1) {
		if s := jsTrim(hashPrefix.ReplaceAllString(l, "")); s != "" {
			return s
		}
	}
	return ""
}

var readableRe = regexp.MustCompile(`^\x{FEFF}?---\r?\n([\s\S]*?)\r?\n---`)

func nomiReadable(text, name string) bool {
	m := readableRe.FindStringSubmatch(text)
	if m == nil {
		return false
	}
	kv := map[string]string{}
	for _, line := range lineSplit.Split(m[1], -1) {
		if x := kvRe.FindStringSubmatch(jsTrim(line)); x != nil {
			kv[strings.ToLower(x[1])] = unquote(jsTrim(x[2]))
		}
	}
	d := kv["description"]
	return kv["name"] == name && d != "" && !blockInd.MatchString(d)
}

var wsAny = regexp.MustCompile(`\s+`)
var scriptRe = regexp.MustCompile(`(?i)\.(sh|py|js|ts|mjs|cjs|ps1|bat|rb)$`)

func skillCandidate(tool, scope, sub, dirName, where string, allow func(string) bool) *SkillCandidate {
	c := &SkillCandidate{Key: tool + ":" + scope + ":skill:" + where, Kind: "skill", Tool: tool, Scope: scope, Name: dirName, Where: where, Dir: sub, Files: []string{}, Warnings: []string{}}
	real := realOrEmpty(sub)
	if real == "" {
		return nil
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return nil
	}
	if DenyDir.MatchString(normSlash(real)) || !allow(real) {
		c.Error = T("electron.common.skipped-a-symbolic-link-points-somewhere-that-may")
		return c
	}
	md := filepath.Join(real, "SKILL.md")
	st, err := os.Lstat(md)
	if err != nil {
		return nil
	}
	c.Dir = real
	if !st.Mode().IsRegular() {
		c.Error = T("electron.common.skill-md-must-be-a-regular-file-not")
		return c
	}
	if st.Size() > maxSkillMd {
		c.Error = T("electron.common.skill-md-is-too-large")
		return c
	}
	b, err := os.ReadFile(md)
	if err != nil {
		return nil
	}
	text := strings.ToValidUTF8(string(b), "\uFFFD")
	meta, body := ParseFrontmatter(text)
	rawName := jsTrim(meta["name"])
	if rawName == "" {
		rawName = dirName
	}
	name := NomiSkillName(rawName)
	if !ValidSkillName(name) {
		c.Error = T("electron.common.invalid-skill-name", rawName)
		return c
	}
	w := []string{}
	if name != rawName {
		w = append(w, T("electron.common.name-adjusted-to-a-format-nomi-supports", name))
	}
	desc := jsTrim(wsAny.ReplaceAllString(meta["description"], " "))
	when, ok := meta["when_to_use"]
	if !ok {
		when = meta["when-to-use"]
	}
	if when = jsTrim(when); when != "" {
		if desc != "" {
			desc = desc + " " + when
		} else {
			desc = when
		}
	}
	if desc == "" {
		desc = firstLine(body)
		if desc != "" {
			w = append(w, T("electron.common.no-description-using-the-first-line-of-the"))
		}
	}
	if desc == "" {
		c.Name = name
		c.Error = T("electron.common.missing-description")
		return c
	}
	wk := walkSkill(real)
	if len(wk.denied) > 0 {
		d := wk.denied
		if len(d) > 5 {
			d = d[:5]
		}
		w = append(w, T("electron.common.these-files-look-like-credentials-or-keys-and", strings.Join(d, "、")))
	}
	if wk.links > 0 {
		w = append(w, T("electron.common.symbolic-links-in-the-skill-folder-won-t", wk.links))
	}
	if wk.truncated {
		w = append(w, T("electron.common.too-many-files-only-the-first-are-copied", maxFiles))
	}
	for _, f := range wk.files {
		if scriptRe.MatchString(f) {
			w = append(w, T("electron.common.bundled-scripts-are-copied-as-reference-files-only"))
			break
		}
	}
	if meta["allowed-tools"] != "" || meta["allowed_tools"] != "" {
		w = append(w, T("electron.common.claude-code-specific-fields-such-as-allowed-tools"))
	}
	var bytes int64
	for _, f := range wk.files {
		if st, err := os.Lstat(filepath.Join(real, f)); err == nil {
			bytes += st.Size()
		}
	}
	files := []string{}
	for _, f := range wk.files {
		if f != "SKILL.md" {
			files = append(files, f)
		}
	}
	c.Name, c.Description, c.Files, c.Bytes = name, deps.Slice0(desc, 1024), files, bytes
	c.Normalize, c.Body, c.Warnings = !nomiReadable(text, name), jsTrim(body), w
	if bytes > MaxSkillBytes {
		c.Error = T("electron.common.skill-pack-too-large-max-5-mb")
	}
	return c
}

func skillsIn(tool, scope, dir, home, project string, allow func(string) bool) []*SkillCandidate {
	ents, err := sortedEntries(dir)
	if err != nil {
		return nil
	}
	if len(ents) > maxEntries {
		ents = ents[:maxEntries]
	}
	out := []*SkillCandidate{}
	for _, d := range ents {
		if strings.HasPrefix(d.Name(), ".") {
			continue
		}
		if !d.IsDir() && d.Type()&os.ModeSymlink == 0 {
			continue
		}
		sub := filepath.Join(dir, d.Name())
		if c := skillCandidate(tool, scope, sub, d.Name(), display(home, sub, project), allow); c != nil {
			out = append(out, c)
		}
	}
	return out
}

func absPath(p string) string { a, _ := filepath.Abs(p); return a }

func DiscoverMigrations(e MigrateEnv) MigrateScan {
	home := absPath(e.Home)
	env := e.Env
	if env == nil {
		env = map[string]string{}
	}
	project := ""
	if e.ProjectDir != "" {
		project = absPath(e.ProjectDir)
	}
	claudeDir := ""
	if env["CLAUDE_CONFIG_DIR"] != "" {
		claudeDir = absPath(env["CLAUDE_CONFIG_DIR"])
	}
	codexHome := env["CODEX_HOME"]
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	codexHome = absPath(codexHome)
	userRoots := []string{home}
	if claudeDir != "" {
		userRoots = append(userRoots, claudeDir)
	}
	userRoots = append(userRoots, codexHome)
	projectRoots := []string{}
	if project != "" {
		projectRoots = []string{project}
	}
	scan := MigrateScan{Mcp: []*McpCandidate{}, Skills: []*SkillCandidate{}, Sources: []MigrateSource{}}
	readJSON := func(tool, file string, max int64, roots []string) any {
		where := display(home, file, project)
		r := ReadConfigFile(file, max, roots)
		if r.Missing {
			scan.Sources = append(scan.Sources, MigrateSource{Tool: tool, Where: where})
			return nil
		}
		if r.Err != "" {
			scan.Sources = append(scan.Sources, MigrateSource{tool, where, true, r.Err})
			return nil
		}
		j, err := deps.ParseJSONOrdered([]byte(r.Text))
		if err != nil {
			scan.Sources = append(scan.Sources, MigrateSource{tool, where, true, T("electron.common.not-valid-json")})
			return nil
		}
		scan.Sources = append(scan.Sources, MigrateSource{Tool: tool, Where: where, Found: true})
		return j
	}
	files := []string{}
	if claudeDir != "" {
		files = append(files, filepath.Join(claudeDir, ".claude.json"))
	}
	files = append(files, filepath.Join(home, ".claude.json"))
	seen := map[string]bool{}
	for _, f := range files {
		if seen[f] {
			continue
		}
		seen[f] = true
		j, ok := readJSON("claude", f, maxClaudeJSON, userRoots).(*deps.OrderedObject)
		if !ok {
			continue
		}
		where := display(home, f, project)
		src := sourceID(f)
		ms, _ := j.Get("mcpServers")
		scan.Mcp = append(scan.Mcp, claudeServers(ms, "claude", "user", where, src, "")...)
		if projects, ok := j.Values["projects"].(*deps.OrderedObject); ok {
			for i, p := range projects.Keys {
				if i >= maxEntries {
					break
				}
				po, _ := projects.Values[p].(*deps.OrderedObject)
				servers, _ := po.Get("mcpServers")
				if !truthy(servers) {
					continue
				}
				scan.Mcp = append(scan.Mcp, claudeServers(servers, "claude", "local", where+" · "+p, src, p+":")...)
			}
		}
	}
	if project != "" {
		file := filepath.Join(project, ".mcp.json")
		if j, ok := readJSON("claude", file, maxConfig, projectRoots).(*deps.OrderedObject); ok {
			ms, _ := j.Get("mcpServers")
			scan.Mcp = append(scan.Mcp, claudeServers(ms, "claude", "project", display(home, file, project), sourceID(file), "")...)
		}
	}
	type cf struct {
		file, scope string
		roots       []string
	}
	cfs := []cf{{filepath.Join(codexHome, "config.toml"), "user", userRoots}}
	if project != "" {
		cfs = append(cfs, cf{filepath.Join(project, ".codex", "config.toml"), "project", projectRoots})
	}
	for _, c := range cfs {
		where := display(home, c.file, project)
		r := ReadConfigFile(c.file, maxConfig, c.roots)
		if r.Missing {
			scan.Sources = append(scan.Sources, MigrateSource{Tool: "codex", Where: where})
			continue
		}
		if r.Err != "" {
			scan.Sources = append(scan.Sources, MigrateSource{"codex", where, true, r.Err})
			continue
		}
		var tbl map[string]any
		if err := toml.Unmarshal([]byte(r.Text), &tbl); err != nil {
			scan.Sources = append(scan.Sources, MigrateSource{"codex", where, true, T("electron.common.invalid-toml-couldn-t-parse-it")})
			continue
		}
		scan.Sources = append(scan.Sources, MigrateSource{Tool: "codex", Where: where, Found: true})
		servers, ok := tbl["mcp_servers"].(map[string]any)
		if !ok {
			continue
		}
		// D-B8：go-toml 解码为 map，表内顺序丢失 → 按名字排序
		names := make([]string, 0, len(servers))
		for k := range servers {
			names = append(names, k)
		}
		sort.Strings(names)
		for i, n := range names {
			if i >= maxEntries {
				break
			}
			scan.Mcp = append(scan.Mcp, toCandidate("codex", c.scope, where, n, FromCodexEntry(n, toJSONish(servers[n])), sourceID(c.file), ""))
		}
	}
	type sd struct{ tool, dir string }
	sds := []sd{}
	if claudeDir != "" {
		sds = append(sds, sd{"claude", filepath.Join(claudeDir, "skills")})
	}
	sds = append(sds, sd{"claude", filepath.Join(home, ".claude", "skills")}, sd{"codex", filepath.Join(home, ".agents", "skills")}, sd{"codex", filepath.Join(codexHome, "skills")})
	userReal := []string{}
	for _, d := range sds {
		if r := realOrEmpty(d.dir); r != "" {
			userReal = append(userReal, r)
		}
	}
	seenDir := map[string]bool{}
	push := func(list []*SkillCandidate) {
		for _, c := range list {
			id := c.Dir
			if c.Error != "" {
				id = c.Key
			}
			if seenDir[id] {
				continue
			}
			seenDir[id] = true
			scan.Skills = append(scan.Skills, c)
		}
	}
	for _, d := range sds {
		push(skillsIn(d.tool, "user", d.dir, home, project, func(string) bool { return true }))
	}
	if project != "" {
		projReal := realOrEmpty(project)
		allow := func(real string) bool {
			if projReal != "" && isWithin(projReal, real) {
				return true
			}
			for _, r := range userReal {
				if isWithin(r, real) {
					return true
				}
			}
			return false
		}
		push(skillsIn("claude", "project", filepath.Join(project, ".claude", "skills"), home, project, allow))
		push(skillsIn("codex", "project", filepath.Join(project, ".agents", "skills"), home, project, allow))
	}
	keySeen := map[string]bool{}
	uniq := func(k *string) {
		base := *k
		x := base
		for i := 2; keySeen[x]; i++ {
			x = base + "#" + itoa(i)
		}
		*k = x
		keySeen[x] = true
	}
	for _, c := range scan.Mcp {
		uniq(&c.Key)
	}
	for _, c := range scan.Skills {
		uniq(&c.Key)
	}
	return scan
}
