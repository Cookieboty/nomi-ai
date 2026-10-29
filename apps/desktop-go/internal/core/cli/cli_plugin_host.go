// cli_plugin_host.go mirrors packages/core/src/cli/CliPluginHost.ts：
// 加载插件、校验清单、算有效能力（清单 ∩ 版本开关 ∩ 握手）、启停、出错隔离，
// 并给界面一份注册表快照（cli.registryChanged）。
package cli

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// PluginStatus = 'loading' | 'ready' | 'invalid' | 'failed'
type PluginStatus = string

// NamedPlugin：Record<string, CliPlugin> 的一项（Go map 无序，按 Object.entries 顺序给出）。
type NamedPlugin struct {
	Key    string
	Plugin clisdk.CliPlugin
}

type HostLogger interface {
	Info(m string, d any)
	Warn(m string, d any)
}

type HostEvents interface {
	Publish(event string, payload any)
}

type CliPluginHostDeps struct {
	Logger HostLogger
	Root   string
	// Plugins nil = 全部内置插件
	Plugins  []NamedPlugin
	Home     *string
	Env      clisdk.Env // nil = process.env
	Platform string     // "" = process.platform
	// Version 读 CLI 版本；Promise 值 nil = null
	Version func(id string) *jsrt.Promise[*string]
	Extend  func(id string, impl *clisdk.CliMainImpl) *clisdk.CliMainImpl
	Events  HostEvents
	// OnVersionChange 第一次读到版本（from = null）不算
	OnVersionChange   func(id, from, to string)
	ExternalDir       string // "" = <root>/external
	SpawnExternal     func(command string, args []string, cwd string) (clisdk.ChildLike, error)
	OnExternalRemoved func(id string)
}

type hostLoaded struct {
	manifest  any // plugin.manifest（可能不是对象）
	builtin   bool
	external  *util.Obj
	status    PluginStatus
	errors    []string
	impl      *clisdk.CliMainImpl
	version   *string
	handshake *util.Obj
}

type CliPluginHost struct {
	d         CliPluginHostDeps
	keys      []string
	loaded    map[string]*hostLoaded
	started   bool
	externals *ExternalPluginStore
}

var inRangeWsRe = regexp.MustCompile(`(?:` + util.JSWhitespace + `)+`)

var inRangePartRe = regexp.MustCompile(`^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+)$`)

// InRange：版本是否满足范围（空格分隔的比较式，全部满足才算）。
func InRange(version, rng string) bool {
	v := ParseSemver(version)
	if v == nil {
		return false
	}
	cmp := func(a, b []float64) int {
		for i := 0; i < 3; i++ {
			if a[i] != b[i] {
				if a[i] > b[i] {
					return 1
				}
				return -1
			}
		}
		return 0
	}
	parts := []string{}
	for _, p := range inRangeWsRe.Split(util.JSTrim(rng), -1) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return false
	}
	for _, p := range parts {
		m := inRangePartRe.FindStringSubmatch(p)
		if m == nil {
			return false
		}
		b := ParseSemver(m[2])
		if b == nil {
			return false
		}
		c := cmp(v, b)
		ok := false
		switch m[1] {
		case ">=":
			ok = c >= 0
		case "<=":
			ok = c <= 0
		case ">":
			ok = c > 0
		case "<":
			ok = c < 0
		default:
			ok = c == 0
		}
		if !ok {
			return false
		}
	}
	return true
}

func NewCliPluginHost(d CliPluginHostDeps) *CliPluginHost {
	h := &CliPluginHost{d: d, loaded: map[string]*hostLoaded{}}
	dir := d.ExternalDir
	if dir == "" {
		dir = filepath.Join(d.Root, "external")
	}
	h.externals = NewExternalPluginStore(dir, h.reservedIDs())
	return h
}

func (h *CliPluginHost) set(id string, l *hostLoaded) {
	if _, ok := h.loaded[id]; !ok {
		h.keys = append(h.keys, id)
	}
	h.loaded[id] = l
}

func (h *CliPluginHost) del(id string) {
	if _, ok := h.loaded[id]; !ok {
		return
	}
	delete(h.loaded, id)
	for i, k := range h.keys {
		if k == id {
			h.keys = append(h.keys[:i:i], h.keys[i+1:]...)
			break
		}
	}
}

func (h *CliPluginHost) plugins() []NamedPlugin {
	if h.d.Plugins != nil {
		return h.d.Plugins
	}
	keys := make([]string, 0, len(builtin.Plugins))
	for k := range builtin.Plugins {
		keys = append(keys, k)
	}
	sort.Strings(keys) // 同 TS BUILTIN_PLUGINS 键序：claude, codex, dsh, gemini, grok
	out := []NamedPlugin{}
	for _, k := range keys {
		out = append(out, NamedPlugin{k, builtin.Plugins[k]})
	}
	return out
}

func (h *CliPluginHost) reservedIDs() []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, id := range builtin.IDs {
		add(id)
	}
	for _, p := range h.d.Plugins {
		add(p.Key)
	}
	add("nomi")
	return out
}

func (h *CliPluginHost) home() string {
	if h.d.Home != nil {
		return *h.d.Home
	}
	return usage.Homedir()
}

func (h *CliPluginHost) env() clisdk.Env {
	if h.d.Env != nil {
		return h.d.Env
	}
	out := clisdk.Env{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			out[kv[:i]] = kv[i+1:]
		}
	}
	return out
}

func manifestObj(m any) *util.Obj { o, _ := m.(*util.Obj); return o }

// Start 加载全部插件；版本在后台读。
func (h *CliPluginHost) Start() *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		if h.started {
			return struct{}{}, nil
		}
		h.started = true
		isBuiltin := h.d.Plugins == nil
		for _, np := range h.plugins() {
			key, plugin := np.Key, np.Plugin
			var mAny any
			if plugin.Manifest != nil {
				mAny = plugin.Manifest
			}
			errs := clisdk.ValidateManifest(mAny)
			id := key
			if m := plugin.Manifest; m != nil {
				if s, ok := m.Get("id").(string); ok {
					id = s
				}
			}
			_, dup := h.loaded[id]
			if len(errs) > 0 || dup {
				why := errs
				if len(why) == 0 {
					why = []string{"duplicate plugin id " + id}
				}
				h.d.Logger.Warn("cli plugin rejected", util.NewObj("id", id, "errors", hostStrs(why)))
				k := id
				if dup {
					k = id + "#" + key
				}
				h.set(k, &hostLoaded{manifest: mAny, builtin: isBuiltin, status: "invalid", errors: why, handshake: util.NewObj()})
				continue
			}
			entry := &hostLoaded{manifest: mAny, builtin: isBuiltin, status: "loading", errors: []string{}, handshake: util.NewObj()}
			h.set(id, entry)
			var impl *clisdk.CliMainImpl
			var err error
			if plugin.Main != nil {
				platform := h.d.Platform
				if platform == "" {
					platform = usage.Platform()
				}
				impl, err = callMain(plugin.Main, clisdk.CliMainHost{Logger: h.d.Logger, DataDir: filepath.Join(h.d.Root, id),
					Home: h.home(), Env: h.env(), Platform: platform})
			}
			if err == nil {
				if impl != nil && h.d.Extend != nil {
					impl = h.d.Extend(id, impl)
				}
				entry.impl = impl
				entry.status = "ready"
			} else {
				entry.status = "failed"
				entry.errors = []string{err.Error()}
				h.d.Logger.Warn("cli plugin failed to start", util.NewObj("id", id, "error", entry.errors[0]))
			}
		}
		h.loadExternals()
		h.changed()
		h.RefreshVersions()
		return struct{}{}, nil
	})
}

// callMain：工厂里的 panic（JS throw）同样隔离到这一个插件。
func callMain(f func(clisdk.CliMainHost) (*clisdk.CliMainImpl, error), host clisdk.CliMainHost) (impl *clisdk.CliMainImpl, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = errors.New(util.JSString(r))
			}
		}
	}()
	return f(host)
}

func hostStrs(s []string) []any {
	out := make([]any, len(s))
	for i, x := range s {
		out[i] = x
	}
	return out
}

func (h *CliPluginHost) loadExternals() {
	for _, e := range h.externals.Load() {
		if _, ok := h.loaded[e.ID]; ok {
			continue
		}
		h.set(e.ID, h.externalEntry(e.ID, e.Spec, e.Errors))
		if len(e.Errors) > 0 {
			h.d.Logger.Warn("external cli plugin rejected", util.NewObj("id", e.ID, "errors", hostStrs(e.Errors)))
		}
	}
}

func (h *CliPluginHost) externalEntry(id string, spec *util.Obj, errs []string) *hostLoaded {
	var m *util.Obj
	status := "invalid"
	if spec != nil {
		m = clisdk.ExternalManifest(spec)
		status = "ready"
	} else {
		m = util.NewObj("id", id, "displayName", id, "icon", "")
	}
	if errs == nil {
		errs = []string{}
	}
	return &hostLoaded{manifest: m, external: spec, status: status, errors: errs, handshake: util.NewObj()}
}

// ExternalSpec：就绪外部插件的清单（nil = undefined）。
func (h *CliPluginHost) ExternalSpec(id string) *util.Obj {
	if l := h.loaded[id]; l != nil && l.status == "ready" {
		return l.external
	}
	return nil
}

// AddExternal 返回 {ok:true, entry} | {ok:false, errors}。
func (h *CliPluginHost) AddExternal(raw any) *util.Obj {
	spec, errs := h.externals.Save(raw)
	if errs != nil {
		return util.NewObj("ok", false, "errors", hostStrs(errs))
	}
	id := util.Str(spec.Get("id"))
	h.set(id, h.externalEntry(id, spec, []string{}))
	h.d.Logger.Info("external cli plugin saved", util.NewObj("id", id))
	h.changed()
	var entry any
	for _, p := range h.Snapshot().Get("plugins").([]any) {
		if p.(*util.Obj).Get("id") == id {
			entry = p
			break
		}
	}
	return util.NewObj("ok", true, "entry", entry)
}

// RemoveExternal 删除外部插件（内置插件不能删）。
func (h *CliPluginHost) RemoveExternal(id string) bool {
	l := h.loaded[id]
	if l == nil || l.builtin || (l.external == nil && l.status != "invalid") {
		return false
	}
	h.externals.Remove(id)
	h.del(id)
	h.d.Logger.Info("external cli plugin removed", util.NewObj("id", id))
	if h.d.OnExternalRemoved != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					h.d.Logger.Warn("external cli plugin remove hook failed", util.NewObj("id", id, "error", jsErrString(r)))
				}
			}()
			h.d.OnExternalRemoved(id)
		}()
	}
	h.changed()
	return true
}

// jsErrString = String(e)：Error → "Error: msg"。
func jsErrString(r any) string {
	if e, ok := r.(error); ok {
		return "Error: " + e.Error()
	}
	return util.JSString(r)
}

// TestExternal：起进程、只做 ACP initialize 握手。
func (h *CliPluginHost) TestExternal(raw any, cwd string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		fail := func(e ...string) (*util.Obj, error) { return util.NewObj("ok", false, "errors", hostStrs(e)), nil }
		if errs := clisdk.ValidateExternalSpec(raw, h.reservedIDs()); len(errs) > 0 {
			return fail(errs...)
		}
		if h.d.SpawnExternal == nil {
			return fail("spawn not available")
		}
		spec := raw.(*util.Obj)
		env := h.env()
		var args []string
		if a, ok := spec.Get("args").([]any); ok {
			for _, x := range a {
				args = append(args, util.Str(x))
			}
		}
		args = clisdk.RenderExternalArgs(args, map[string]string{"cwd": cwd, "home": h.home()})
		child, err := h.d.SpawnExternal(util.Str(spec.Get("command")), args, cwd)
		if err != nil {
			return fail(err.Error())
		}
		race := jsrt.NewPromise[*util.Obj]()
		child.OnError(func(e error) { race.Reject(e) })
		jsrt.Async(func() (struct{}, error) {
			v, e := drivers.ProbeAcp(child, nil, nil)
			if e != nil {
				race.Reject(e)
			} else {
				race.Resolve(v)
			}
			return struct{}{}, nil
		})
		r, err := jsrt.Await(race)
		if err != nil {
			return fail(err.Error())
		}
		out := util.NewObj("ok", true, "missingEnv", hostStrs(clisdk.MissingExternalEnv(spec, env)))
		out.Assign(r)
		return out, nil
	})
}

// Stop 丢掉主进程实现。
func (h *CliPluginHost) Stop() {
	for _, l := range h.loaded {
		l.impl = nil
	}
	h.loaded = map[string]*hostLoaded{}
	h.keys = nil
	h.started = false
}

// RefreshVersions 重新读各 CLI 的版本；版本变了才广播。
func (h *CliPluginHost) RefreshVersions() *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (struct{}, error) {
		if h.d.Version == nil {
			return struct{}{}, nil
		}
		changed := false
		ps := []*jsrt.Promise[struct{}]{}
		for _, id := range append([]string(nil), h.keys...) {
			id, l := id, h.loaded[id]
			ps = append(ps, jsrt.Async(func() (struct{}, error) {
				if l.status == "invalid" || l.external != nil {
					return struct{}{}, nil
				}
				v, err := jsrt.Await(h.d.Version(id))
				if err != nil {
					v = nil
				}
				if !strPtrEq(v, l.version) {
					from := l.version
					l.version = v
					changed = true
					if from != nil && *from != "" && v != nil && *v != "" && h.d.OnVersionChange != nil {
						func() {
							defer func() {
								if r := recover(); r != nil {
									h.d.Logger.Warn("cli plugin version hook failed", util.NewObj("id", id, "error", jsErrString(r)))
								}
							}()
							h.d.OnVersionChange(id, *from, *v)
						}()
					}
				}
				return struct{}{}, nil
			}))
		}
		for _, p := range ps {
			_, _ = jsrt.Await(p)
		}
		if changed {
			h.changed()
		}
		return struct{}{}, nil
	})
}

func strPtrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// SetHandshake：驱动握手报告的能力，只能关掉能力。
func (h *CliPluginHost) SetHandshake(id string, caps *util.Obj) {
	l := h.loaded[id]
	if l == nil {
		return
	}
	n := util.NewObj()
	n.Assign(l.handshake)
	if caps != nil {
		n.Assign(caps)
	}
	l.handshake = n
	h.changed()
}

// Impl：已就绪插件的主进程实现（nil = undefined）。
func (h *CliPluginHost) Impl(id string) *clisdk.CliMainImpl {
	if l := h.loaded[id]; l != nil && l.status == "ready" {
		return l.impl
	}
	return nil
}

// Manifest：ok=false = undefined（未加载）；已加载但清单为 null 时 (nil, true)。
func (h *CliPluginHost) Manifest(id string) (any, bool) {
	if l := h.loaded[id]; l != nil {
		return l.manifest, true
	}
	return nil, false
}

// Capabilities（nil = undefined）。
func (h *CliPluginHost) Capabilities(id string) *util.Obj {
	l := h.loaded[id]
	if l == nil || l.status == "invalid" {
		return nil
	}
	m := manifestObj(l.manifest)
	if m == nil {
		m = util.NewObj()
	}
	return clisdk.EffectiveCapabilities(m, l.version, InRange, l.handshake)
}

func (h *CliPluginHost) Snapshot() *util.Obj {
	plugins := []any{}
	for _, id := range h.keys {
		l := h.loaded[id]
		m := manifestObj(l.manifest)
		get := func(k string) any {
			if m == nil {
				return nil
			}
			return m.Get(k)
		}
		dn, ok := get("displayName").(string)
		if !ok {
			dn = id
		}
		icon, _ := get("icon").(string)
		var ver any
		if l.version != nil {
			ver = *l.version
		}
		caps := h.Capabilities(id)
		if caps == nil {
			caps = util.NewObj()
		}
		e := util.NewObj("id", id, "displayName", dn, "icon", icon, "builtin", l.builtin, "status", l.status,
			"errors", hostStrs(l.errors), "version", ver)
		for _, k := range []string{"transport", "ingress", "modelSwitch"} {
			if m != nil && m.Has(k) {
				e.Set(k, m.Get(k))
			}
		}
		e.Set("capabilities", caps)
		if l.external != nil {
			x := util.NewObj()
			x.Assign(l.external)
			x.Set("missingEnv", hostStrs(clisdk.MissingExternalEnv(l.external, h.env())))
			e.Set("external", x)
		}
		plugins = append(plugins, e)
	}
	return util.NewObj("plugins", plugins)
}

// TestExternalInTemp：试运行在临时目录里做。
func (h *CliPluginHost) TestExternalInTemp(raw any) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		dir, err := os.MkdirTemp("", "nomi-cli-test-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(dir)
		return jsrt.Await(h.TestExternal(raw, dir))
	})
}

func (h *CliPluginHost) changed() {
	if h.d.Events != nil {
		h.d.Events.Publish("cli.registryChanged", h.Snapshot())
	}
}
