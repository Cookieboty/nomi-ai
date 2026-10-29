package accounts

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

var codexAppServerArgs = []string{"-s", "read-only", "-a", "never", "-c", "analytics.enabled=false", "app-server"}

const codexAccountTimeoutMs = 15_000

// CodexAccountInfo = CodexAccountInfo.
type CodexAccountInfo struct {
	LoggedIn  bool
	Email     string
	Plan      string
	AccountID string
	APIKey    bool
}

// CodexAccountDeps = CodexAccountDeps (ResolveBin nil = resolveCliBinAsync('codex')).
type CodexAccountDeps struct {
	ResolveBin func() (string, error)
	SpawnFn    func(file string, args []string, o nodeproc.Options) *nodeproc.Child
	TimeoutMs  int
	TmpRoot    string
	Platform   string
}

// MapCodexAccount = mapCodexAccount (nil = null).
func MapCodexAccount(result any) *CodexAccountInfo {
	r := rec(result)
	if r == nil {
		return nil
	}
	if v, ok := r.Lookup("account"); ok && v == nil {
		return &CodexAccountInfo{LoggedIn: false}
	}
	a := rec(r.Get("account"))
	if a == nil {
		return nil
	}
	switch a.Get("type") {
	case "chatgpt":
		plan := strTrim(a.Get("planType"))
		if plan == "unknown" {
			plan = ""
		}
		return &CodexAccountInfo{LoggedIn: true, Email: strTrim(a.Get("email")), Plan: plan}
	case "apiKey":
		return &CodexAccountInfo{LoggedIn: true, APIKey: true}
	}
	return &CodexAccountInfo{LoggedIn: true}
}

var cmdBatRe = regexp.MustCompile(`(?i)\.(cmd|bat)$`)

// ReadCodexAccount = readCodexAccount（持 jsrt 锁调用；nil = null）。
func ReadCodexAccount(env *util.Obj, extraArgs []string, withAccountID bool, d CodexAccountDeps) (info *CodexAccountInfo) {
	var bin string
	if d.ResolveBin != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					bin = ""
				}
			}()
			b, err := d.ResolveBin()
			if err == nil {
				bin = b
			}
		}()
	} else {
		bin = cli.ResolveCliBinAsync("codex")
	}
	if bin == "" {
		return nil
	}
	root := d.TmpRoot
	if root == "" {
		root = os.TempDir()
	}
	cwd, err := usage.NodeMkdtemp(filepath.Join(root, "nomi-codex-account-"))
	if err != nil {
		panic(jsThrow("Error", err.Error()))
	}
	var child *nodeproc.Child
	defer func() {
		if child != nil {
			child.Stdin.End()
			usage.KillTree(child, 500)
		}
		_ = os.RemoveAll(cwd)
	}()
	file := bin
	args := append(append([]string{}, extraArgs...), codexAppServerArgs...)
	platform := d.Platform
	if platform == "" {
		platform = usage.Platform()
	}
	if platform == "win32" && cmdBatRe.MatchString(bin) {
		f, a, ok := usage.WindowsShimLaunch(bin, args, env)
		if !ok {
			return nil
		}
		file, args = f, a
	}
	spawn := d.SpawnFn
	if spawn == nil {
		spawn = nodeproc.Spawn
	}
	child = spawn(file, args, nodeproc.Options{Cwd: cwd, Env: usage.EnvSlice(env), Verbatim: file != bin, IgnoreStderr: true})
	timeout := d.TimeoutMs
	if timeout == 0 {
		timeout = codexAccountTimeoutMs
	}
	rpc := newMiniRpc(child, timeout)
	defer rpc.close()
	params := util.NewObj("clientInfo", util.NewObj("name", "nomi_accounts", "title", "Nomi", "version", "1.0.0"))
	if _, err := jsrt.Await(rpc.request("initialize", params)); err != nil {
		return nil
	}
	rpc.notify("initialized")
	res, err := jsrt.Await(rpc.request("account/read", util.NewObj()))
	if err != nil {
		return nil
	}
	info = MapCodexAccount(res)
	if info == nil {
		return nil
	}
	if withAccountID && info.LoggedIn && !info.APIKey {
		limits, err := jsrt.Await(rpc.request("account/rateLimits/read", undef))
		if err != nil {
			limits = nil
		}
		if id := strTrim(rec(limits).Get("accountId")); id != "" {
			info.AccountID = id
		}
	}
	return info
}

type rpcWaiter struct{ p *jsrt.Promise[any] }

// miniRpc = MiniRpc（按行 JSON-RPC，只认带 id 的响应）。
type miniRpc struct {
	child   *nodeproc.Child
	seq     int
	buf     string
	total   int
	dead    error
	pending map[int]rpcWaiter
	order   []int
	timer   *jsrt.Timer
	carry   []byte
}

func newMiniRpc(child *nodeproc.Child, timeoutMs int) *miniRpc {
	r := &miniRpc{child: child, pending: map[int]rpcWaiter{}}
	r.timer = jsrt.SetTimeout(time.Duration(timeoutMs)*time.Millisecond, func() { r.fail(errors.New("timeout")) })
	once := map[string]bool{}
	child.OnError(func(error) {
		if !once["error"] {
			once["error"] = true
			r.fail(errors.New("spawn"))
		}
	})
	child.OnClose(func(*int, string) {
		if !once["close"] {
			once["close"] = true
			r.fail(errors.New("closed"))
		}
	})
	child.OnStdoutBytes(func(b []byte) {
		s := r.decode(b)
		r.total += len16(s)
		r.buf += s
		if r.total > usage.StdoutLimit {
			r.fail(errors.New("output-limit"))
			return
		}
		for {
			i := strings.IndexByte(r.buf, '\n')
			if i < 0 {
				break
			}
			line := r.buf[:i]
			r.buf = r.buf[i+1:]
			r.onLine(line)
		}
	})
	return r
}

// decode = setEncoding('utf8')（StringDecoder：跨块拼接多字节字符）。
func (r *miniRpc) decode(b []byte) string {
	data := append(r.carry, b...)
	r.carry = nil
	// 末尾不完整的多字节序列留到下一块
	for back := 1; back <= 3 && back <= len(data); back++ {
		c := data[len(data)-back]
		if c < 0x80 {
			break
		}
		if c >= 0xC0 {
			need := 0
			switch {
			case c >= 0xF0:
				need = 4
			case c >= 0xE0:
				need = 3
			default:
				need = 2
			}
			if need > back && !utf8.FullRune(data[len(data)-back:]) && validPrefix(data[len(data)-back:]) {
				r.carry = append([]byte{}, data[len(data)-back:]...)
				data = data[:len(data)-back]
			}
			break
		}
	}
	return nodeproc.DecodeChunk(data)
}

func validPrefix(b []byte) bool {
	// 不完整但到目前为止合法的前缀（之后的字节可能补全）
	c := b[0]
	if c < 0xC2 || c > 0xF4 {
		return false
	}
	for i, x := range b[1:] {
		lo, hi := byte(0x80), byte(0xBF)
		if i == 0 {
			switch c {
			case 0xE0:
				lo = 0xA0
			case 0xED:
				hi = 0x9F
			case 0xF0:
				lo = 0x90
			case 0xF4:
				hi = 0x8F
			}
		}
		if x < lo || x > hi {
			return false
		}
	}
	return true
}

func (r *miniRpc) request(method string, params any) *jsrt.Promise[any] {
	if r.dead != nil {
		return jsrt.Rejected[any](r.dead)
	}
	r.seq++
	id := r.seq
	p := jsrt.NewPromise[any]()
	r.pending[id] = rpcWaiter{p}
	r.order = append(r.order, id)
	m := util.NewObj("id", float64(id), "method", method)
	if !isUndef(params) {
		m.Set("params", params)
	}
	if r.child.Stdin != nil {
		r.child.Stdin.Write(util.Stringify(m) + "\n")
	}
	return p
}

func (r *miniRpc) notify(method string) {
	if r.child.Stdin != nil {
		r.child.Stdin.Write(util.Stringify(util.NewObj("method", method)) + "\n")
	}
}

func (r *miniRpc) close() {
	jsrt.ClearTimeout(r.timer)
	if r.dead == nil {
		r.dead = errors.New("closed")
	}
}

func (r *miniRpc) onLine(line string) {
	v, err := util.ParseString(line)
	if err != nil {
		return
	}
	m := rec(v)
	if m == nil {
		return
	}
	idf, ok := m.Get("id").(float64)
	if !ok || idf != math.Trunc(idf) || math.Abs(idf) > 1<<53 {
		return
	}
	id := int(idf)
	w, ok := r.pending[id]
	if !ok {
		return
	}
	delete(r.pending, id)
	if truthy(orElse(m.Get("error"), undef)) && m.Has("error") {
		w.p.Reject(errors.New("rpc"))
	} else {
		res, ok := m.Lookup("result")
		if !ok {
			res = undef
		}
		w.p.Resolve(res)
	}
}

func (r *miniRpc) fail(e error) {
	if r.dead != nil {
		return
	}
	r.dead = e
	jsrt.ClearTimeout(r.timer)
	for _, id := range r.order {
		if w, ok := r.pending[id]; ok {
			w.p.Reject(e)
		}
	}
	r.pending = map[int]rpcWaiter{}
	r.order = nil
}
