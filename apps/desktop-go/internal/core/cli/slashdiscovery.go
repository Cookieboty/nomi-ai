package cli

// slashdiscovery.go = apps/desktop-electron/internal/core/src/cli/slashDiscovery.ts（斜杠命令/技能/代理/插件/MCP 发现与展开 + gitBranch/gitDiff）。

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const (
	slashMaxPerDir = 200
	slashMaxDepth  = 3
	slashHeadBytes = 8 * 1024
	slashBodyBytes = 64 * 1024
	slashMaxWalkUp = 12
	slashDescMax   = 300
)

var (
	// DENY / DENY_DIR（/i，非 unicode：输入先过 JSIText）。
	slashDeny    = regexp.MustCompile(`(?i)(^|/)(\.credentials.*|auth\.json|\.env.*|.*\.key|.*\.pem|.*\.(p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.dockercfg|kubeconfig|credentials(\.json)?|settings(\.local)?\.json|config\.toml|\.claude\.json|service[-_]?account.*\.json|.*\.tfvars(\.json)?|secrets?(\.[\w-]+)?\.(json|ya?ml|toml|env|txt)|\.htpasswd|.*\.kdbx|history\.jsonl|\.[\w-]*_history)$`)
	slashDenyDir = regexp.MustCompile(`(?i)(^|/)(\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.docker|\.git|\.password-store|Keychains)(/|$)|(^|/)\.config/(gcloud|gh|git)(/|$)`)
)

// jsDot = JS 的 `.`（不匹配 \n \r \u2028 \u2029）。
const jsDot = `[^\n\r\x{2028}\x{2029}]`

// SlashDeny / SlashDenyDir = DENY.test / DENY_DIR.test。
func SlashDeny(p string) bool    { return slashDeny.MatchString(denyText(p)) }
func SlashDenyDir(p string) bool { return slashDenyDir.MatchString(denyText(p)) }

// `.` 在 JS 里不跨行终止符：把它们换成 '\n'（RE2 `.` 不匹配 \n，(^|/) 等锚点不受影响）。
func denyText(p string) string {
	s := util.JSIText(p)
	return strings.NewReplacer("\r", "\n", "\u2028", "\n", "\u2029", "\n").Replace(s)
}

var userContentDirs = []string{".claude/skills", ".claude/commands", ".claude/agents", ".agents/skills", ".grok/skills", ".grok/commands", ".grok/plugins", ".grok/workflows", ".grok/bundled"}

type slashInternal struct {
	entry *util.Obj
	file  string
	dir   string
}

func slashNorm(p string) string { return strings.ReplaceAll(p, `\`, "/") }

func slashIsWithin(root, p string) bool {
	rel := pathRel(root, p)
	return rel == "" || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

// fs.realpathSync（JS 实现，非 native）。
func jsRealpath(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(r)
}

func realOrSelf(p string) string {
	if r, err := jsRealpath(p); err == nil {
		return r
	}
	return absOf(p)
}

// nodeExtname = path.extname。
func nodeExtname(p string) string {
	b := filepath.Base(p)
	if b == "." || b == string(filepath.Separator) {
		return ""
	}
	start := 0
	for start < len(b) && b[start] == '.' {
		start++
	}
	i := strings.LastIndexByte(b, '.')
	if i < start || i == 0 {
		if i >= 0 && i == start-1 && start < len(b) && start > 1 {
			return b[i:]
		}
		return ""
	}
	return b[i:]
}

func readHead(file string, n int, allow func(string) bool) (string, bool) {
	if SlashDeny(slashNorm(file)) {
		return "", false
	}
	real, err := jsRealpath(file)
	if err != nil {
		return "", false
	}
	rn := slashNorm(real)
	if SlashDeny(rn) || SlashDenyDir(rn) {
		return "", false
	}
	if strings.ToLower(nodeExtname(real)) != strings.ToLower(nodeExtname(file)) {
		return "", false
	}
	if allow != nil && !allow(real) {
		return "", false
	}
	f, err := os.Open(real)
	if err != nil {
		return "", false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return "", false
	}
	again, err := os.Stat(real)
	if err != nil || !os.SameFile(st, again) {
		return "", false
	}
	if r2, err := jsRealpath(real); err != nil || r2 != real {
		return "", false
	}
	size := int(st.Size())
	if n > size {
		n = size
	}
	buf := make([]byte, n)
	m, _ := f.ReadAt(buf, 0)
	return charcontract.DecodeUTF8(buf[:m]), true
}

func unquote(v string) string {
	s := util.JSTrim(v)
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] && !strings.ContainsAny(s[1:len(s)-1], "\n\r\u2028\u2029") {
		return s[1 : len(s)-1]
	}
	return s
}

var (
	reFMStart  = regexp.MustCompile(`^---\r?\n`)
	reCRLFSp   = regexp.MustCompile(`\r?\n`)
	reFMEnd    = util.JSRe(`^---\s*$`)
	reFMKey    = util.JSRe(`^([A-Za-z_][\w-]*):\s*(` + jsDot + `*)$`)
	reFMBlock  = regexp.MustCompile(`^[>|][+-]?$`)
	reFMCont   = util.JSRe(`^\s+\S`)
	reFMDash   = util.JSRe(`^-\s+`)
	reFalse    = regexp.MustCompile(`(?i)^(false|no|off|0)$`)
	reHashes   = util.JSRe(`^#+\s*`)
	reSafeName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:-]*$`)
	reWfExt    = regexp.MustCompile(`(?i)\.(rhai|js)$`)
	reTrailCm  = util.JSRe(`,\s*$`)
)

// ParseFrontmatter = parseFrontmatter（meta 键小写，有序）。
func ParseFrontmatter(text string) (*util.Obj, string) {
	t := strings.TrimPrefix(text, "\uFEFF")
	meta := util.NewObj()
	if !reFMStart.MatchString(t) {
		return meta, t
	}
	lines := reCRLFSp.Split(t, -1)
	end := -1
	for i := 1; i < len(lines); i++ {
		if reFMEnd.MatchString(lines[i]) {
			end = i
			break
		}
	}
	if end < 0 {
		return meta, t
	}
	for i := 1; i < end; i++ {
		m := reFMKey.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		key := util.JSLower(m[1])
		val := m[2]
		if reFMBlock.MatchString(util.JSTrim(val)) || util.JSTrim(val) == "" {
			parts := []string{}
			for i+1 < end && reFMCont.MatchString(lines[i+1]) {
				i++
				parts = append(parts, reFMDash.ReplaceAllString(util.JSTrim(lines[i]), ""))
			}
			sep := " "
			if strings.HasPrefix(util.JSTrim(val), "|") {
				sep = "\n"
			}
			val = strings.Join(parts, sep)
		}
		meta.Set(key, unquote(val))
	}
	return meta, strings.Join(lines[end+1:], "\n")
}

func metaStr(m *util.Obj, k string) (string, bool) {
	v, ok := m.Lookup(k)
	if !ok {
		return "", false
	}
	return v.(string), true
}

func isFalseMeta(m *util.Obj, k string) bool {
	v, ok := metaStr(m, k)
	return ok && reFalse.MatchString(util.JSTrim(v))
}

func firstLine(body string) string {
	for _, l := range reCRLFSp.Split(body, -1) {
		if s := util.JSTrim(reHashes.ReplaceAllString(l, "")); s != "" {
			return s
		}
	}
	return ""
}

func clip(s string, n int) string {
	if util.UTF16Len(s) > n {
		return clisdk.Slice0(s, n-1) + "…"
	}
	return s
}

func workflowField(text, key string) string {
	re := util.JSRe(`(?:^|\n)\s*(?:\*\s*)?` + key + `:\s*(?:"([^"]*)"|'([^']*)'|([^\n]+))`)
	m := re.FindStringSubmatchIndex(text)
	v := ""
	if m != nil {
		for g := 1; g <= 3; g++ {
			if m[2*g] >= 0 {
				v = text[m[2*g]:m[2*g+1]]
				break
			}
		}
	}
	return reTrailCm.ReplaceAllString(util.JSTrim(v), "")
}

type slashDirent struct {
	name      string
	dir, link bool
}

func listDir(dir string) []slashDirent {
	es, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]slashDirent, 0, len(es))
	for _, e := range es {
		t := e.Type()
		link := t&os.ModeSymlink != 0 || (runtime.GOOS == "windows" && t&os.ModeIrregular != 0)
		out = append(out, slashDirent{e.Name(), t.IsDir(), link})
	}
	c := collate.New(language.AmericanEnglish)
	sort.SliceStable(out, func(i, j int) bool { return c.CompareString(out[i].name, out[j].name) < 0 })
	if len(out) > slashMaxPerDir {
		out = out[:slashMaxPerDir]
	}
	return out
}

func isDirPath(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func existsPath(p string) bool { _, err := os.Stat(p); return err == nil }

// ProjectChain = projectChain。
func ProjectChain(cwd string) []string {
	cur := absOf(cwd)
	root := ""
	for i, p := 0, cur; i < slashMaxWalkUp; i++ {
		if existsPath(filepath.Join(p, ".git")) {
			root = p
			break
		}
		up := filepath.Dir(p)
		if up == p {
			break
		}
		p = up
	}
	if root == "" {
		return []string{cur}
	}
	out := []string{}
	for i := 0; i < slashMaxWalkUp; i++ {
		out = append(out, cur)
		if cur == root {
			break
		}
		up := filepath.Dir(cur)
		if up == cur {
			break
		}
		cur = up
	}
	return out
}

type slashCollector struct {
	items                                              []slashInternal
	seen                                               map[string]bool
	cwd, home                                          string
	projectLexical, projectReal, userLexical, userReal []string
}

func newSlashCollector(cwd, home string) *slashCollector {
	c := &slashCollector{seen: map[string]bool{}, cwd: cwd, home: home}
	for _, d := range ProjectChain(cwd) {
		c.projectLexical = append(c.projectLexical, absOf(d))
		c.projectReal = append(c.projectReal, realOrSelf(d))
	}
	for _, d := range userContentDirs {
		u := filepath.Join(home, filepath.FromSlash(d))
		c.userLexical = append(c.userLexical, absOf(u))
		c.userReal = append(c.userReal, realOrSelf(u))
	}
	return c
}

func anyWithin(roots []string, p string) bool {
	for _, r := range roots {
		if slashIsWithin(r, p) {
			return true
		}
	}
	return false
}

func (c *slashCollector) read(file string, n int) (string, bool) {
	lex := absOf(file)
	inUser := anyWithin(c.userLexical, lex)
	inProject := !inUser && anyWithin(c.projectLexical, lex)
	var allow func(string) bool
	if inProject {
		allow = func(real string) bool { return anyWithin(c.projectReal, real) || anyWithin(c.userReal, real) }
	}
	return readHead(file, n, allow)
}

func (c *slashCollector) where(file string) string {
	rel := pathRel(absOf(c.cwd), absOf(file))
	if rel != "" && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
		return slashNorm(rel)
	}
	h := pathRel(absOf(c.home), absOf(file))
	if h != "" && !strings.HasPrefix(h, "..") && !filepath.IsAbs(h) {
		return "~/" + slashNorm(h)
	}
	return filepath.Base(file)
}

func (c *slashCollector) add(i slashInternal) {
	id := i.entry.Get("id").(string)
	if c.seen[id] {
		return
	}
	c.seen[id] = true
	c.items = append(c.items, i)
}

func entryObj(id, name, kind, scope, desc string) *util.Obj {
	return util.NewObj("id", id, "name", name, "kind", kind, "scope", scope, "description", desc)
}

func (c *slashCollector) commands(dir, scope, plugin string, depth int, prefix string) {
	for _, d := range listDir(dir) {
		full := filepath.Join(dir, d.name)
		if strings.HasPrefix(d.name, ".") {
			continue
		}
		if d.dir || (d.link && isDirPath(full)) {
			if depth < slashMaxDepth {
				c.commands(full, scope, plugin, depth+1, prefix+d.name+":")
			}
			continue
		}
		if !strings.HasSuffix(util.JSLower(d.name), ".md") {
			continue
		}
		head, ok := c.read(full, slashHeadBytes)
		if !ok {
			continue
		}
		meta, body := ParseFrontmatter(head)
		base := prefix + clisdk.Slice0(d.name, util.UTF16Len(d.name)-3)
		name := base
		if plugin != "" {
			name = plugin + ":" + base
		}
		desc, _ := metaStr(meta, "description")
		if desc == "" {
			desc = firstLine(body)
		}
		e := entryObj(scope+":command:"+plugin+":"+base, name, "command", scope, clip(desc, slashDescMax))
		if ah, _ := metaStr(meta, "argument-hint"); ah != "" {
			e.Set("argumentHint", clip(ah, 80))
		}
		e.Set("userInvocable", !isFalseMeta(meta, "user-invocable") && !isFalseMeta(meta, "user_invocable"))
		if plugin != "" {
			e.Set("plugin", plugin)
		}
		e.Set("where", c.where(full))
		c.add(slashInternal{entry: e, file: full})
	}
}

func (c *slashCollector) skills(dir, scope, plugin string, strict bool) {
	for _, d := range listDir(dir) {
		sub := filepath.Join(dir, d.name)
		if strings.HasPrefix(d.name, ".") || !(d.dir || (d.link && isDirPath(sub))) {
			continue
		}
		file := filepath.Join(sub, "SKILL.md")
		head, ok := c.read(file, slashHeadBytes)
		if !ok {
			continue
		}
		meta, body := ParseFrontmatter(head)
		base := d.name
		if n, _ := metaStr(meta, "name"); util.JSTrim(n) != "" {
			base = util.JSTrim(n)
		}
		name := base
		if plugin != "" {
			name = plugin + ":" + base
		}
		parts := []string{}
		if s, _ := metaStr(meta, "description"); s != "" {
			parts = append(parts, s)
		}
		w, ok := metaStr(meta, "when_to_use")
		if !ok {
			w, _ = metaStr(meta, "when-to-use")
		}
		if w != "" {
			parts = append(parts, w)
		}
		desc := strings.Join(parts, " ")
		if desc == "" {
			desc = firstLine(body)
		}
		e := entryObj(scope+":skill:"+plugin+":"+base, name, "skill", scope, clip(desc, slashDescMax))
		if ah, _ := metaStr(meta, "argument-hint"); ah != "" {
			e.Set("argumentHint", clip(ah, 80))
		}
		if strict {
			ui, ok := metaStr(meta, "user-invocable")
			e.Set("userInvocable", !ok || ui == "true")
		} else {
			e.Set("userInvocable", !isFalseMeta(meta, "user-invocable"))
		}
		if plugin != "" {
			e.Set("plugin", plugin)
		}
		e.Set("where", c.where(sub))
		c.add(slashInternal{entry: e, file: file, dir: sub})
	}
}

func (c *slashCollector) agents(dir, scope string) {
	for _, d := range listDir(dir) {
		if strings.HasPrefix(d.name, ".") || !strings.HasSuffix(util.JSLower(d.name), ".md") {
			continue
		}
		full := filepath.Join(dir, d.name)
		head, ok := c.read(full, slashHeadBytes)
		if !ok {
			continue
		}
		meta, body := ParseFrontmatter(head)
		name := clisdk.Slice0(d.name, util.UTF16Len(d.name)-3)
		if n, _ := metaStr(meta, "name"); util.JSTrim(n) != "" {
			name = util.JSTrim(n)
		}
		desc, _ := metaStr(meta, "description")
		if desc == "" {
			desc = firstLine(body)
		}
		e := entryObj(scope+":agent::"+name, name, "agent", scope, clip(desc, slashDescMax))
		e.Set("userInvocable", false)
		e.Set("where", c.where(full))
		c.add(slashInternal{entry: e, file: full})
	}
}

func (c *slashCollector) mcp(file, scope, plugin string) {
	raw, ok := c.read(file, 256*1024)
	if !ok {
		return
	}
	j, err := util.ParseString(raw)
	if err != nil {
		return
	}
	jo, ok := j.(*util.Obj)
	if !ok {
		return
	}
	type kv struct {
		k string
		v any
	}
	entries := []kv{}
	switch s := jo.Get("mcpServers").(type) {
	case *util.Obj:
		for _, k := range s.Keys() {
			entries = append(entries, kv{k, s.Get(k)})
		}
	case []any:
		for i, v := range s {
			entries = append(entries, kv{strconv.Itoa(i), v})
		}
	default:
		return
	}
	if len(entries) > slashMaxPerDir {
		entries = entries[:slashMaxPerDir]
	}
	for _, e := range entries {
		http := false
		if o, ok := e.v.(*util.Obj); ok {
			_, isStr := o.Get("url").(string)
			t := o.Get("type")
			http = isStr || t == "http" || t == "sse"
		}
		ent := entryObj(scope+":mcp:"+plugin+":"+e.k, e.k, "mcp", scope, "")
		ent.Set("userInvocable", false)
		if plugin != "" {
			ent.Set("plugin", plugin)
		}
		ent.Set("where", c.where(file))
		tr := "stdio"
		if http {
			tr = "http"
		}
		ent.Set("transport", tr)
		c.add(slashInternal{entry: ent, file: file})
	}
}

func (c *slashCollector) workflows(dir, scope string) {
	for _, d := range listDir(dir) {
		if strings.HasPrefix(d.name, ".") || d.dir {
			continue
		}
		full := filepath.Join(dir, d.name)
		if d.link && isDirPath(full) {
			continue
		}
		lower := util.JSLower(d.name)
		if !strings.HasSuffix(lower, ".rhai") && !strings.HasSuffix(lower, ".js") {
			continue
		}
		head, ok := c.read(full, slashHeadBytes)
		if !ok {
			continue
		}
		mName, mDesc := workflowField(head, "name"), workflowField(head, "description")
		stem := reWfExt.ReplaceAllString(d.name, "")
		raw := util.JSTrim(mName)
		if raw == "" {
			raw = stem
		}
		base := ""
		if reSafeName.MatchString(raw) {
			base = raw
		} else if reSafeName.MatchString(stem) {
			base = stem
		}
		if base == "" {
			continue
		}
		e := entryObj(scope+":workflow::"+base, base, "command", scope, clip(mDesc, slashDescMax))
		e.Set("userInvocable", true)
		e.Set("where", c.where(full))
		c.add(slashInternal{entry: e, file: full})
	}
}

func (c *slashCollector) plugins(dir, scope string) {
	for _, d := range listDir(dir) {
		sub := filepath.Join(dir, d.name)
		if strings.HasPrefix(d.name, ".") || d.name == "marketplaces" || !isDirPath(sub) {
			continue
		}
		name, desc := d.name, ""
		if mf, ok := c.read(filepath.Join(sub, "plugin.json"), slashHeadBytes); ok && mf != "" {
			if j, err := util.ParseString(mf); err == nil {
				if o, ok := j.(*util.Obj); ok {
					if n, ok := o.Get("name").(string); ok && util.JSTrim(n) != "" {
						name = util.JSTrim(n)
					}
					if s, ok := o.Get("description").(string); ok {
						desc = clip(s, slashDescMax)
					}
				}
			}
		}
		e := entryObj(scope+":plugin::"+name, name, "plugin", scope, desc)
		e.Set("userInvocable", false)
		e.Set("plugin", name)
		e.Set("where", c.where(sub))
		c.add(slashInternal{entry: e, file: sub})
		c.skills(filepath.Join(sub, "skills"), "plugin", name, true)
		c.commands(filepath.Join(sub, "commands"), "plugin", name, 0, "")
		c.agents(filepath.Join(sub, "agents"), "plugin")
		c.mcp(filepath.Join(sub, ".mcp.json"), "plugin", name)
	}
}

func slashOf(backend string) *clisdk.SlashDiscoveryCapability {
	switch backend {
	case "claude":
		return claude.Slash
	case "codex":
		return codex.Slash
	case "grok":
		return grok.Slash
	}
	return nil // nomi / dsh / gemini：无 slash
}

func slashCollect(backend, cwd, home string) *slashCollector {
	c := newSlashCollector(cwd, home)
	s := slashOf(backend)
	if s == nil || s.Sources == nil {
		return c
	}
	for _, src := range s.Sources(ProjectChain(cwd), home) {
		switch src.Kind {
		case "skills":
			c.skills(src.Path, src.Scope, "", src.StrictInvocable != nil && *src.StrictInvocable)
		case "commands":
			c.commands(src.Path, src.Scope, "", 0, "")
		case "agents":
			c.agents(src.Path, src.Scope)
		case "mcp":
			c.mcp(src.Path, src.Scope, "")
		case "plugins":
			c.plugins(src.Path, src.Scope)
		default:
			c.workflows(src.Path, src.Scope)
		}
	}
	return c
}

// HasPublicLayout = hasPublicLayout。
func HasPublicLayout(b string) bool { s := slashOf(b); return s != nil && s.Sources != nil }

// DiscoverSlash = discoverSlash（home "" = os.homedir()）。
func DiscoverSlash(backend, cwd, home string) *util.Obj {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	entries := []any{}
	if !HasPublicLayout(backend) {
		return util.NewObj("backend", backend, "entries", entries, "supported", false)
	}
	for _, i := range slashCollect(backend, cwd, home).items {
		entries = append(entries, i.entry)
	}
	return util.NewObj("backend", backend, "entries", entries, "supported", true)
}

var (
	jsWSClass = util.JSWhitespace[1 : len(util.JSWhitespace)-1]
	reArgs    = regexp.MustCompile(`"([^"]*)"|'([^']*)'|([^` + jsWSClass + `]+)`)
	reTmpl    = regexp.MustCompile(`\\\$|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)|\$([A-Za-z_]\w*)`)
	reIdent   = regexp.MustCompile(`^[A-Za-z_]\w*$`)
	reArgSep  = regexp.MustCompile(`[` + jsWSClass + `,]+`)
	reBrack   = regexp.MustCompile(`^\[|\]$`)
	reShellIn = util.JSRe("(?m)(^|\\s)!`[^`]+`|^```!")
	reNumstat = regexp.MustCompile(`^(-|\d+)\t(-|\d+)\t((?s:.*))$`)
)

// SplitArgs = splitArgs。
func SplitArgs(s string) []string {
	out := []string{}
	for _, m := range reArgs.FindAllStringSubmatchIndex(s, -1) {
		v := ""
		for g := 1; g <= 3; g++ {
			if m[2*g] >= 0 {
				v = s[m[2*g]:m[2*g+1]]
				break
			}
		}
		out = append(out, v)
	}
	return out
}

// ExpandTemplate = expandTemplate。
func ExpandTemplate(body, args string, named []string) (string, bool) {
	list := SplitArgs(args)
	consumed := false
	names := []string{}
	for _, n := range named {
		if reIdent.MatchString(n) {
			names = append(names, n)
		}
	}
	var sb strings.Builder
	last := 0
	for _, m := range reTmpl.FindAllStringSubmatchIndex(body, -1) {
		sb.WriteString(body[last:m[0]])
		last = m[1]
		whole := body[m[0]:m[1]]
		grp := func(g int) (string, bool) {
			if m[2*g] < 0 {
				return "", false
			}
			return body[m[2*g]:m[2*g+1]], true
		}
		rep := whole
		switch {
		case whole == `\$`:
			rep = "$"
		case whole == "$ARGUMENTS":
			consumed, rep = true, args
		default:
			idx, ok := grp(1)
			if !ok {
				idx, ok = grp(2)
			}
			if ok {
				if k, err := strconv.Atoi(idx); err == nil && k < len(list) {
					consumed, rep = true, list[k]
				}
			} else if nm, ok := grp(3); ok {
				for k, n := range names {
					if n == nm {
						consumed, rep = true, ""
						if k < len(list) {
							rep = list[k]
						}
						break
					}
				}
			}
		}
		sb.WriteString(rep)
	}
	sb.WriteString(body[last:])
	return sb.String(), consumed
}

// ExpandSlash = expandSlash（nil = null；home "" = os.homedir()）。
func ExpandSlash(backend, cwd, id, args, home string) *util.Obj {
	if !HasPublicLayout(backend) {
		return nil
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	c := slashCollect(backend, cwd, home)
	var hit *slashInternal
	for i := range c.items {
		if c.items[i].entry.Get("id") == id {
			hit = &c.items[i]
			break
		}
	}
	if hit == nil {
		return nil
	}
	kind := hit.entry.Get("kind").(string)
	if kind != "command" && kind != "skill" {
		return nil
	}
	if parts := strings.Split(hit.entry.Get("id").(string), ":"); len(parts) > 1 && parts[1] == "workflow" {
		return nil
	}
	raw, ok := c.read(hit.file, slashBodyBytes)
	if !ok {
		return nil
	}
	meta, body := ParseFrontmatter(raw)
	argStr, _ := metaStr(meta, "arguments")
	named := []string{}
	for _, s := range reArgSep.Split(argStr, -1) {
		if s = reBrack.ReplaceAllString(s, ""); s != "" {
			named = append(named, s)
		}
	}
	text, consumed := ExpandTemplate(util.JSTrim(body), util.JSTrim(args), named)
	shell := reShellIn.MatchString(strings.NewReplacer("\r", "\n", "\u2028", "\n", "\u2029", "\n").Replace(body))
	header := ""
	if kind == "skill" && hit.dir != "" {
		header = "[Skill: " + hit.entry.Get("name").(string) + " — " + hit.dir + "]\n\n"
	}
	tail := ""
	if !consumed && util.JSTrim(args) != "" {
		tail = "\n\nARGUMENTS: " + util.JSTrim(args)
	}
	return util.NewObj("text", util.JSTrim(header+text+tail), "shellInjection", shell)
}

// ParseNumstat = parseNumstat。
func ParseNumstat(raw string) *util.Obj {
	out := util.NewObj()
	parts := strings.Split(raw, "\x00")
	for i := 0; i < len(parts); i++ {
		m := reNumstat.FindStringSubmatch(strings.TrimPrefix(parts[i], "\n"))
		if m == nil {
			continue
		}
		file := m[3]
		if file == "" {
			file = ""
			if i+2 < len(parts) {
				file = parts[i+2]
			}
			i += 2
		}
		if file == "" || m[1] == "-" || m[2] == "-" {
			continue
		}
		out.Set(file, util.NewObj("added", util.ToNumber(m[1]), "removed", util.ToNumber(m[2])))
	}
	return out
}

const slashDiffMax = 4 * 1024 * 1024

// slashGit = slashDiscovery 的 git()：失败时错误为 stderr 首个非空行，否则 execFile 的错误。
func slashGit(cwd string, args []string) (string, error) {
	jsrt.Leave()
	r := gitExecWith(cwd, args, 8000, "", 32*1024*1024, GitEnv())
	jsrt.Enter()
	if r.err == "" {
		return r.Stdout, nil
	}
	for _, l := range strings.Split(r.rawStderr, "\n") {
		if t := util.JSTrim(l); t != "" {
			return "", errors.New(t)
		}
	}
	return "", errors.New(r.err)
}

func gitOr(cwd string, args []string) string {
	s, err := slashGit(cwd, args)
	if err != nil {
		return ""
	}
	return s
}

// GitBranch = gitBranch（nil = null）。
func GitBranch(cwd string) *util.Obj {
	if b := util.JSTrim(gitOr(cwd, []string{"symbolic-ref", "--short", "-q", "HEAD"})); b != "" {
		return util.NewObj("branch", b)
	}
	if sha := util.JSTrim(gitOr(cwd, []string{"rev-parse", "--short", "HEAD"})); sha != "" {
		return util.NewObj("branch", nil, "detached", sha)
	}
	return nil
}

// GitDiff = gitDiff。
func GitDiff(cwd string) *util.Obj {
	flags := []string{"--no-ext-diff", "--no-textconv", "--no-color"}
	st, err := slashGit(cwd, []string{"status", "--short", "--untracked-files=normal"})
	if err != nil {
		return util.NewObj("ok", false, "status", "", "stat", "", "diff", "", "truncated", false, "error", strings.Split(err.Error(), "\n")[0])
	}
	status := util.JSTrimEnd(st)
	d := func(extra ...string) string { return gitOr(cwd, append(append([]string{"diff"}, flags...), extra...)) }
	stat := util.JSTrim(d("--stat", "HEAD"))
	full, cached, work := d("HEAD"), d("--cached"), d()
	nsHead, nsStaged, nsWork := d("--numstat", "-z", "HEAD"), d("--numstat", "-z", "--cached"), d("--numstat", "-z")
	truncated := false
	capd := func(s string) string {
		if util.UTF16Len(s) > slashDiffMax {
			truncated = true
			return clisdk.Slice0(s, slashDiffMax)
		}
		return s
	}
	f, c, w := capd(full), capd(cached), capd(work)
	return util.NewObj("ok", true, "status", status, "stat", stat, "diff", f, "staged", c, "unstaged", w, "truncated", truncated,
		"numstat", util.NewObj("head", ParseNumstat(nsHead), "staged", ParseNumstat(nsStaged), "unstaged", ParseNumstat(nsWork)))
}
