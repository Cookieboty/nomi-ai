package usage

import (
	"crypto/rand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
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

// GrokAuthReaderDeps：未设置的字段用默认实现（ResolveBin 由 cli.ResolveCliBinAsync("grok") 注入）。
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

// GrokAccountProbe：initialize 原始结果 JSON 及同一 ACP 会话顺带读出的身份/订阅元数据（仅内存中转，不写日志不落盘）。
type GrokAccountProbe struct {
	Init     string
	AuthInfo *util.Obj
	Billing  *util.Obj
	OK       bool
}

func grokStrTrim(v any) string {
	if s, ok := v.(string); ok {
		return util.JSTrim(s)
	}
	return ""
}

// ReadGrokAuthStatus = readGrokAuthStatus（"" , false = null）。须在 jsrt 线程内 Await。
func ReadGrokAuthStatus(d GrokAuthReaderDeps) (string, bool) {
	probe := readGrokProbe(d, false)
	if !probe.OK {
		return "", false
	}
	return probe.Init, true
}

// ReadGrokAccountProbe：拉起一次 grok agent stdio，读取登录态并（已登录时）顺带查询 _x.ai/auth/info 与 _x.ai/billing。
func ReadGrokAccountProbe(d GrokAuthReaderDeps) GrokAccountProbe {
	return readGrokProbe(d, true)
}

func readGrokProbe(d GrokAuthReaderDeps, withIdentity bool) GrokAccountProbe {
	resolve := d.ResolveBin
	if resolve == nil {
		resolve = DefaultGrokBin
	}
	bin, ok := "", false
	if resolve != nil {
		func() { defer func() { _ = recover() }(); bin, ok = resolve() }()
	}
	if !ok || bin == "" {
		return GrokAccountProbe{}
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
		_ = nodefs.RmForce(dir)
		return GrokAccountProbe{}
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
		_ = nodefs.RmForce(dir)
		return GrokAccountProbe{}
	}
	defer func() {
		KillTree(child, 200)
		_ = nodefs.RmForce(dir)
	}()
	p := jsrt.NewPromise[*GrokAccountProbe]()
	settled := false
	bytes := 0
	buf := ""
	gotInit := false
	initStr := ""
	gotInfo := false
	gotBilling := false
	var authInfo, billing *util.Obj
	var timer, billingTimer *jsrt.Timer
	finish := func(v *GrokAccountProbe) {
		if settled {
			return
		}
		settled = true
		jsrt.ClearTimeout(timer)
		jsrt.ClearTimeout(billingTimer)
		p.Resolve(v)
	}
	finishPartialOrNil := func() {
		if gotInit && initStr != "" {
			finish(&GrokAccountProbe{Init: initStr, AuthInfo: authInfo, Billing: billing, OK: true})
			return
		}
		finish(nil)
	}
	to := d.TimeoutMs
	if to == 0 {
		to = GrokAuthTimeoutMs
	}
	timer = jsrt.SetTimeout(time.Duration(to)*time.Millisecond, finishPartialOrNil)
	child.OnError(func(error) { finishPartialOrNil() })
	child.OnClose(func(*int, string) { finishPartialOrNil() })
	send := func(m *util.Obj) bool {
		if child.Stdin == nil {
			return false
		}
		return child.Stdin.Write(util.Stringify(m) + "\n")
	}
	child.OnStdout(func(s string) {
		bytes += len(s)
		if bytes > StdoutLimit {
			finishPartialOrNil()
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
			o, ok := parsed.(*util.Obj)
			if !ok || o == nil {
				continue
			}
			id, hasID := o.Get("id").(float64)
			if !hasID {
				continue
			}
			switch id {
			case 1:
				if gotInit {
					continue
				}
				if !util.Truthy(o.Get("result")) {
					finish(nil)
					return
				}
				gotInit = true
				initStr = util.Stringify(o.Get("result"))
				if !withIdentity || ParseGrokAuthStatus(initStr) != AuthSubscription {
					finish(&GrokAccountProbe{Init: initStr, OK: true})
					return
				}
				send(util.NewObj("jsonrpc", "2.0", "id", float64(2), "method", "_x.ai/auth/info", "params", util.NewObj()))
				send(util.NewObj("jsonrpc", "2.0", "id", float64(3), "method", "_x.ai/billing", "params", util.NewObj()))
			case 2:
				if gotInfo {
					continue
				}
				gotInfo = true
				if r, ok := o.Get("result").(*util.Obj); ok && r != nil {
					authInfo = r
				}
				hasTier := grokStrTrim(authInfo.Get("subscriptionTier")) != "" || grokStrTrim(authInfo.Get("subscription_tier")) != ""
				if hasTier || gotBilling {
					finish(&GrokAccountProbe{Init: initStr, AuthInfo: authInfo, Billing: billing, OK: true})
					return
				}
				billingTimer = jsrt.SetTimeout(1200*time.Millisecond, func() {
					finish(&GrokAccountProbe{Init: initStr, AuthInfo: authInfo, Billing: billing, OK: true})
				})
			case 3:
				if gotBilling {
					continue
				}
				gotBilling = true
				if r, ok := o.Get("result").(*util.Obj); ok && r != nil {
					billing = r
				}
				if gotInfo {
					finish(&GrokAccountProbe{Init: initStr, AuthInfo: authInfo, Billing: billing, OK: true})
					return
				}
			}
		}
	})
	req := util.NewObj("jsonrpc", "2.0", "id", float64(1), "method", "initialize", "params",
		util.NewObj("protocolVersion", float64(1),
			"clientInfo", util.NewObj("name", "nomi_usage", "title", "Nomi", "version", "1.0.0"),
			"clientCapabilities", util.NewObj()))
	if !send(req) && child.Stdin == nil {
		finish(nil)
	}
	r, _ := jsrt.Await(p)
	if r == nil {
		return GrokAccountProbe{}
	}
	return *r
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
