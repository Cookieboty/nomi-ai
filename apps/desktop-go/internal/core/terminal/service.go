package terminal

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwagents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Commands = class TerminalCommands
type Commands struct {
	d         Deps
	home      string
	platform  string
	stateFile string
	BinDir    string
	TokenDir  string
	WorkDir   string
	mu        sync.Mutex
	st        persisted
}

func New(d Deps) *Commands {
	c := &Commands{d: d}
	if d.Home != nil {
		c.home = *d.Home
	} else {
		c.home, _ = os.UserHomeDir()
	}
	c.platform = d.Platform
	if c.platform == "" {
		c.platform = NodePlatform()
	}
	c.stateFile = filepath.Join(d.Root, "terminal.json")
	c.BinDir = filepath.Join(c.home, ".nomi", "bin")
	c.TokenDir = filepath.Join(d.Root, "tokens")
	c.WorkDir = filepath.Join(d.Root, "terminal")
	c.st = c.load()
	return c
}

func (c *Commands) load() persisted {
	b, err := os.ReadFile(c.stateFile)
	if err != nil {
		return persisted{}
	}
	v, err := u.Parse(b)
	if err != nil {
		return persisted{}
	}
	raw, ok := v.(*u.Obj)
	if !ok {
		// JSON.parse 得到 null 时取属性抛错 → catch；数组 / 原始值属性均为 undefined
		if v == nil {
			return persisted{}
		}
		raw = u.NewObj()
	}
	own := raw.Get("windowsPathOwned") == true
	p := persisted{enabled: raw.Get("enabled") == true, pathAdded: raw.Get("pathAdded") == true, windowsPathOwned: &own}
	if arr, ok := raw.Get("rcFiles").([]any); ok {
		p.rcFiles = []string{}
		for _, x := range arr {
			p.rcFiles = append(p.rcFiles, i18n.JSString(jsStringable(x)))
		}
	}
	return p
}

// jsStringable：String(x) 对对象 / 数组的结果
func jsStringable(x any) any {
	switch v := x.(type) {
	case *u.Obj:
		return "[object Object]"
	case []any:
		parts := make([]string, len(v))
		for i, e := range v {
			if e != nil {
				parts[i] = i18n.JSString(jsStringable(e))
			}
		}
		return joinComma(parts)
	}
	return x
}

func joinComma(p []string) string {
	s := ""
	for i, x := range p {
		if i > 0 {
			s += ","
		}
		s += x
	}
	return s
}

func (c *Commands) stObj() *u.Obj {
	o := u.NewObj("enabled", c.st.enabled, "pathAdded", c.st.pathAdded)
	if c.st.windowsPathOwned != nil {
		o.Set("windowsPathOwned", *c.st.windowsPathOwned)
	}
	if c.st.rcFiles != nil {
		o.Set("rcFiles", strs(c.st.rcFiles))
	}
	return o
}

func strs(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

func (c *Commands) save() {
	_ = os.MkdirAll(c.d.Root, 0o700)
	_ = WritePrivateFile(c.stateFile, u.StringifyIndent(c.stObj(), "  "))
}

type rcCand struct{ file, shell string }

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func (c *Commands) rcCandidates() []rcCand {
	h := c.home
	all := []rcCand{{filepath.Join(h, ".zshrc"), "posix"}, {filepath.Join(h, ".bashrc"), "posix"},
		{filepath.Join(h, ".config", "fish", "config.fish"), "fish"}}
	present := []rcCand{}
	for _, x := range all {
		if exists(x.file) {
			present = append(present, x)
		}
	}
	if len(present) > 0 {
		return present
	}
	shell := os.Getenv("SHELL")
	if c.d.Shell != nil {
		shell = *c.d.Shell
	}
	b := ""
	if shell != "" {
		b = filepath.Base(shell)
	}
	switch {
	case b == "fish":
		return []rcCand{all[2]}
	case b == "bash":
		if c.platform == "darwin" {
			return []rcCand{{filepath.Join(h, ".bash_profile"), "posix"}}
		}
		return []rcCand{all[1]}
	case b == "zsh" || c.platform == "darwin":
		return []rcCand{all[0]}
	}
	return []rcCand{{filepath.Join(h, ".profile"), "posix"}}
}

// State = state()
func (c *Commands) State() *u.Obj {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state()
}

func (c *Commands) state() *u.Obj {
	rc := []any{}
	if c.platform != "win32" {
		if c.st.pathAdded && len(c.st.rcFiles) > 0 {
			rc = strs(c.st.rcFiles)
		} else {
			for _, x := range c.rcCandidates() {
				rc = append(rc, x.file)
			}
		}
	}
	kind := "shell-rc"
	if c.platform == "win32" {
		kind = "user-path"
	}
	cmds := []any{}
	for _, k := range Kinds {
		cmds = append(cmds, CommandName(k, c.platform))
		if c.platform == "win32" {
			cmds = append(cmds, "nomi-"+k+".ps1")
		}
	}
	return u.NewObj("enabled", c.st.enabled, "pathAdded", c.st.pathAdded, "binDir", c.BinDir, "rcFiles", rc,
		"pathSupported", true, "pathKind", kind, "commands", cmds)
}

// Set = set({enabled, addToPath?})；addToPath nil = undefined
func (c *Commands) Set(enabled bool, addToPath *bool) (out *u.Obj, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			out = nil
			if e, ok := r.(error); ok {
				err = e
			} else {
				panic(r)
			}
		}
	}()
	if enabled {
		c.st.enabled = true
		c.save()
		c.refresh()
		if addToPath != nil && *addToPath {
			c.addPath()
		} else if addToPath != nil && !*addToPath {
			c.removePath()
		}
	} else {
		c.st.enabled = false
		c.removePath()
		c.removeGenerated()
		c.save()
	}
	return c.state(), nil
}

// Refresh = refresh()
func (c *Commands) Refresh() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refresh()
}

func (c *Commands) refresh() {
	if !c.st.enabled {
		return
	}
	if c.d.OnEnabled != nil {
		c.d.OnEnabled()
	}
	func() {
		defer func() {
			if r := recover(); r != nil && c.d.Logger != nil {
				c.d.Logger.Warn("terminal commands: generate failed", r)
			}
		}()
		if err := c.generate(); err != nil && c.d.Logger != nil {
			c.d.Logger.Warn("terminal commands: generate failed", err)
		}
	}()
}

func (c *Commands) generate() error {
	src := c.d.Source()
	if src == nil {
		return nil
	}
	if err := os.MkdirAll(c.BinDir, 0o777); err != nil {
		return err
	}
	if err := EnsurePrivateDir(c.TokenDir); err != nil {
		return err
	}
	if err := os.MkdirAll(c.WorkDir, 0o700); err != nil {
		return err
	}
	if c.platform == "win32" {
		if err := writeIfChanged(filepath.Join(c.BinDir, "nomi-runner.cjs"), WindowsRunner, 0o600); err != nil {
			return err
		}
	}
	for _, kind := range Kinds {
		client := src.Clients[kind]
		tokenFile := filepath.Join(c.TokenDir, kind)
		if client != nil && client.Token != nil && *client.Token != "" {
			if err := writeIfChanged(tokenFile, *client.Token, 0o600); err != nil {
				return err
			}
		} else {
			_ = os.RemoveAll(tokenFile)
		}
		var model *string
		if client != nil && client.Models != nil {
			if m, ok := client.Models.Get("main").(string); ok {
				model = &m
			}
		}
		var launch *gwagents.Launch
		var template *string
		if model != nil && client != nil {
			home := c.home
			ctx := &gwagents.LaunchContext{URL: src.URL, Token: tokenMark, Model: *model, Models: client.Models,
				Dir: filepath.Join(c.WorkDir, kind), MetaOf: src.MetaOf, Catalog: src.Catalog, Home: &home, Platform: c.platform}
			launch = gwagents.AgentLaunch(kind, ctx)
			t, err := c.template(kind, ctx)
			if err != nil {
				return err
			}
			template = t
		}
		in := &ScriptInput{Kind: kind, Platform: c.platform, URL: src.URL, TokenFile: tokenFile, Model: model, Launch: launch, Template: template}
		if err := writeIfChanged(filepath.Join(c.BinDir, CommandName(kind, c.platform)), BuildScript(in), 0o755); err != nil {
			return err
		}
		if c.platform == "win32" {
			cfg := in.obj()
			if launch == nil {
				cfg.Set("launch", nil) // { launch: undefined } → JSON 省略
				cfg.Delete("launch")
			}
			cfg.Set("messages", u.NewObj(
				"noModel", i18n.T("electron.common.no-third-party-model-is-set-for-choose", kind),
				"needModel", i18n.T("electron.common.nomi-model-must-be-followed-by-provider-model"),
				"badModel", i18n.T("electron.common.invalid-model-name-prefix"),
				"down", i18n.T("electron.common.please-start-nomi-first-the-gateway-is-not", src.URL),
				"noToken", i18n.T("electron.common.token-not-found-turn-terminal-commands-off-and"),
				"noBin", i18n.T("electron.common.was-not-found-please-install-it-first", kind),
				"unsafeShim", i18n.T("electron.common.cannot-safely-launch-reinstall-the-cli-or-use", kind),
			))
			if err := WritePrivateFile(filepath.Join(c.BinDir, "nomi-"+kind+".json"), u.Stringify(cfg)); err != nil {
				return err
			}
			if err := writeIfChanged(filepath.Join(c.BinDir, "nomi-"+kind+".ps1"), powershellScript(kind), 0o755); err != nil {
				return err
			}
		}
	}
	return nil
}

var modelLineRe = regexp.MustCompile(`(?m)^model = .*$`)

func (c *Commands) template(kind string, ctx *gwagents.LaunchContext) (*string, error) {
	if kind != "grok" && kind != "dsh" {
		return nil, nil
	}
	dir := filepath.Join(c.WorkDir, "templates")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if kind == "dsh" {
		tdir := filepath.Join(dir, "dsh")
		cp := *ctx
		cp.Model, cp.Dir = modelMark, tdir
		gwagents.AgentLaunch("dsh", &cp)
		f := filepath.Join(tdir, "patch.yml")
		return &f, nil
	}
	b, err := os.ReadFile(filepath.Join(ctx.Dir, "config.toml"))
	if err != nil {
		return nil, err
	}
	file := filepath.Join(dir, "grok.config.toml")
	cfg := string(b)
	done := false
	cfg = modelLineRe.ReplaceAllStringFunc(cfg, func(m string) string {
		if done {
			return m
		}
		done = true
		return `model = "` + modelMark + `"`
	})
	if err := WritePrivateFile(file, cfg); err != nil {
		return nil, err
	}
	return &file, nil
}

func (c *Commands) removeGenerated() {
	for _, kind := range Kinds {
		_ = os.RemoveAll(filepath.Join(c.BinDir, CommandName(kind, c.platform)))
		if c.platform == "win32" {
			_ = os.RemoveAll(filepath.Join(c.BinDir, "nomi-"+kind+".ps1"))
			_ = os.RemoveAll(filepath.Join(c.BinDir, "nomi-"+kind+".json"))
		}
		_ = os.RemoveAll(filepath.Join(c.TokenDir, kind))
	}
	if c.platform == "win32" {
		_ = os.RemoveAll(filepath.Join(c.BinDir, "nomi-runner.cjs"))
	}
	_ = os.RemoveAll(c.WorkDir) // RemoveAll 不跟随软链
	for _, d := range []string{c.BinDir, c.TokenDir, filepath.Dir(c.BinDir)} {
		_ = rmdir(d)
	}
}

func (c *Commands) winPath(dir string, add bool) bool {
	if c.d.WindowsPath != nil {
		return c.d.WindowsPath(dir, add)
	}
	return UpdateWindowsPath(dir, add)
}

func (c *Commands) addPath() {
	if c.platform == "win32" {
		added := c.winPath(c.BinDir, true)
		own := (c.st.windowsPathOwned != nil && *c.st.windowsPathOwned) || added
		c.st.windowsPathOwned = &own
		c.st.pathAdded = true
		c.save()
		return
	}
	done := []string{}
	for _, x := range c.rcCandidates() {
		cur := ""
		if exists(x.file) {
			b, err := os.ReadFile(x.file)
			if err != nil {
				c.warn("terminal commands: add PATH failed", x.file, err)
				continue
			}
			cur = string(b)
		}
		next := AddRcBlock(cur, x.shell)
		if next != cur {
			if err := os.MkdirAll(filepath.Dir(x.file), 0o777); err != nil {
				c.warn("terminal commands: add PATH failed", x.file, err)
				continue
			}
			if err := os.WriteFile(x.file, []byte(next), 0o666); err != nil {
				c.warn("terminal commands: add PATH failed", x.file, err)
				continue
			}
		}
		done = append(done, x.file)
	}
	c.st.pathAdded = len(done) > 0
	c.st.rcFiles = done
	c.save()
}

func (c *Commands) warn(m, file string, e error) {
	if c.d.Logger != nil {
		c.d.Logger.Warn(m, u.NewObj("file", file, "e", e.Error()))
	}
}

func (c *Commands) removePath() {
	if c.platform == "win32" {
		if c.st.windowsPathOwned != nil && *c.st.windowsPathOwned {
			c.winPath(c.BinDir, false)
		}
		c.st.pathAdded = false
		c.st.windowsPathOwned = nil
		c.save()
		return
	}
	seen := map[string]bool{}
	files := []string{}
	add := func(f string) {
		if !seen[f] {
			seen[f] = true
			files = append(files, f)
		}
	}
	for _, f := range c.st.rcFiles {
		add(f)
	}
	for _, x := range c.rcCandidates() {
		add(x.file)
	}
	h := c.home
	for _, f := range []string{filepath.Join(h, ".zshrc"), filepath.Join(h, ".bashrc"), filepath.Join(h, ".bash_profile"),
		filepath.Join(h, ".profile"), filepath.Join(h, ".config", "fish", "config.fish")} {
		add(f)
	}
	for _, f := range files {
		if !exists(f) {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			c.warn("terminal commands: remove PATH failed", f, err)
			continue
		}
		cur := string(b)
		if next := RemoveRcBlock(cur); next != cur {
			if err := os.WriteFile(f, []byte(next), 0o666); err != nil {
				c.warn("terminal commands: remove PATH failed", f, err)
			}
		}
	}
	c.st.pathAdded = false
	c.st.rcFiles = nil
	c.save()
}

func writeIfChanged(file, data string, mode os.FileMode) error {
	if b, err := os.ReadFile(file); err == nil && string(b) == data {
		return os.Chmod(file, mode)
	}
	if mode == 0o600 {
		return WritePrivateFile(file, data)
	}
	if err := os.WriteFile(file, []byte(data), mode); err != nil {
		return err
	}
	_ = os.Chmod(file, mode)
	return nil
}
