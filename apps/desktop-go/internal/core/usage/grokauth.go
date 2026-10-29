package usage

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

var GrokAgentArgs = []string{"agent", "stdio"}

const GrokAuthTimeoutMs = 6_000

func authPayload(v any) *util.Obj {
	o, ok := v.(*util.Obj)
	if !ok || o == nil {
		return nil
	}
	if _, ok := o.Get("authMethods").([]any); ok {
		return o
	}
	if o.Has("result") {
		return authPayload(o.Get("result"))
	}
	return nil
}

var (
	crlfRe      = regexp.MustCompile(`\r?\n`)
	loginishRe  = regexp.MustCompile(`(?i)cached[_-]?token|oauth|grok\.com`)
	loggedInRe  = regexp.MustCompile(`(?i)cached[_-]?token|oauth`)
	apiRe       = regexp.MustCompile(`(?i)api[_-]?key|deployment|env[_-]?key`)
	cachedTokRe = regexp.MustCompile(`(?i)cached[_-]?token`)
)

// ParseGrokAuthStatus = parseGrokAuthStatus（"" = null）。
func ParseGrokAuthStatus(text string) string {
	var values []any
	for _, line := range crlfRe.Split(text, -1) {
		if util.JSTrim(line) == "" {
			continue
		}
		if v, err := util.ParseString(line); err == nil {
			values = append(values, v)
		}
	}
	if len(values) == 0 {
		v, err := util.ParseString(text)
		if err != nil {
			return ""
		}
		values = append(values, v)
	}
	for _, value := range values {
		p := authPayload(value)
		if p == nil {
			continue
		}
		defaultID := ""
		meta, _ := p.Get("_meta").(*util.Obj)
		if meta != nil {
			if s, ok := meta.Get("defaultAuthMethodId").(string); ok {
				defaultID = s
			} else if s, ok := p.Get("defaultAuthMethodId").(string); ok {
				defaultID = s
			}
		} else if s, ok := p.Get("defaultAuthMethodId").(string); ok {
			defaultID = s
		}
		if loginishRe.MatchString(defaultID) && loggedInRe.MatchString(defaultID) {
			return "subscription"
		}
		if apiRe.MatchString(defaultID) {
			return "api"
		}
		cached := false
		for _, m := range p.Get("authMethods").([]any) {
			if x, ok := m.(*util.Obj); ok && x != nil {
				if id, ok := x.Get("id").(string); ok && cachedTokRe.MatchString(id) {
					cached = true
					break
				}
			}
		}
		if cached && defaultID == "" {
			return "subscription"
		}
	}
	return ""
}

// GrokAuthReaderDeps：未设置的字段用默认实现（ResolveBin 在 batch 7 由 cli.ResolveCliBinAsync("grok") 注入）。
type GrokAuthReaderDeps struct {
	ResolveBin func() (string, bool)
	SpawnFn    func(file string, args []string, o nodeproc.Options) *nodeproc.Child
	Env        func() *util.Obj
	TmpRoot    string
	TimeoutMs  int
	Platform   string
}

// DefaultGrokBin / DefaultCliEnv：由 core/cli 在 init 时接上（避免 usage → cli 的循环引用）。
var (
	DefaultGrokBin func() (string, bool)
	DefaultCliEnv  func() *util.Obj
)

// ReadGrokAuthStatus = readGrokAuthStatus（"" , false = null）。须在 jsrt 线程内 Await。
func ReadGrokAuthStatus(d GrokAuthReaderDeps) (string, bool) {
	resolve := d.ResolveBin
	if resolve == nil {
		resolve = DefaultGrokBin
	}
	bin, ok := "", false
	if resolve != nil {
		func() { defer func() { _ = recover() }(); bin, ok = resolve() }()
	}
	if !ok || bin == "" {
		return "", false
	}
	root := d.TmpRoot
	if root == "" {
		root = os.TempDir()
	}
	dir, err := NodeMkdtemp(filepath.Join(root, "nomi-grok-auth-"))
	if err != nil {
		panic(err) // mkdtempSync 抛错 = async 函数 reject
	}
	envFn := d.Env
	if envFn == nil {
		envFn = DefaultCliEnv
	}
	env := envFn()
	platform := d.Platform
	if platform == "" {
		platform = Platform()
	}
	launch := ResolveCliLaunch(bin, GrokAgentArgs, env, platform, UnwrapCmdDeps{})
	if launch == nil {
		_ = os.RemoveAll(dir)
		return "", false
	}
	spawn := d.SpawnFn
	if spawn == nil {
		spawn = nodeproc.Spawn
	}
	childEnv := env.Clone()
	childEnv.Set("NO_COLOR", "1")
	var child *nodeproc.Child
	func() {
		defer func() { _ = recover() }()
		child = spawn(launch.File, launch.Args, nodeproc.Options{
			Cwd: dir, Env: EnvSlice(childEnv), IgnoreStderr: true, Verbatim: launch.Via == ViaCmdShim,
		})
	}()
	if child == nil {
		_ = os.RemoveAll(dir)
		return "", false
	}
	defer func() {
		KillTree(child, 200)
		_ = os.RemoveAll(dir)
	}()
	p := jsrt.NewPromise[*string]()
	settled := false
	bytes := 0
	buf := ""
	var timer *jsrt.Timer
	finish := func(v *string) {
		if settled {
			return
		}
		settled = true
		jsrt.ClearTimeout(timer)
		p.Resolve(v)
	}
	to := d.TimeoutMs
	if to == 0 {
		to = GrokAuthTimeoutMs
	}
	timer = jsrt.SetTimeout(time.Duration(to)*time.Millisecond, func() { finish(nil) })
	child.OnError(func(error) { finish(nil) })
	child.OnClose(func(*int, string) { finish(nil) })
	child.OnStdout(func(s string) {
		bytes += len(s)
		if bytes > StdoutLimit {
			finish(nil)
			return
		}
		buf += s
		for {
			i := strings.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+1:]
			parsed, err := util.ParseString(line)
			if err != nil {
				continue
			}
			if o, ok := parsed.(*util.Obj); ok && o != nil {
				if n, ok := o.Get("id").(float64); ok && n == 1 && util.Truthy(o.Get("result")) {
					s := util.Stringify(o.Get("result"))
					finish(&s)
					return
				}
			}
		}
	})
	req := util.NewObj("jsonrpc", "2.0", "id", float64(1), "method", "initialize", "params",
		util.NewObj("protocolVersion", float64(1),
			"clientInfo", util.NewObj("name", "nomi_usage", "title", "Nomi", "version", "1.0.0"),
			"clientCapabilities", util.NewObj()))
	if child.Stdin == nil || !child.Stdin.Write(util.Stringify(req)+"\n") {
		if child.Stdin == nil {
			finish(nil)
		}
	}
	r, _ := jsrt.Await(p)
	if r == nil {
		return "", false
	}
	return *r, true
}

const mkdtempChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// NodeMkdtemp = fs.mkdtempSync(prefix)：prefix 后接 6 个 [A-Za-z0-9] 随机字符（libuv uv_fs_mkdtemp），权限 0700。
func NodeMkdtemp(prefix string) (string, error) {
	for i := 0; i < 100; i++ {
		var b [6]byte
		_, _ = rand.Read(b[:])
		for j := range b {
			b[j] = mkdtempChars[int(b[j])%len(mkdtempChars)]
		}
		dir := prefix + string(b[:])
		err := os.Mkdir(dir, 0o700)
		if err == nil {
			return dir, nil
		}
		if !os.IsExist(err) {
			return "", err
		}
	}
	return "", os.ErrExist
}
