package providers

// ProviderStore —— 对应 packages/ai-runtime/src/providers/ProviderStore.ts。
//
// 数据保持 JSON 形状的动态对象（与 Node 的 ProviderStoreData 同构），这样持久化的
// `JSON.stringify(data, null, 2)`、视图键序与 undefined 槽位都与 Node 逐字节一致。
// Node 里 throw 的地方返回 error；中途已做的修改同样保留（与 Node 抛错前的副作用一致）。

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ProviderRoles：PROVIDER_ROLES
var ProviderRoles = []string{"chat", "agent-tools", "summary"}

// StoreOptions：ProviderStoreOptions
type StoreOptions struct {
	// FilePath：JSON 文件路径；"" = 仅内存
	FilePath string
	Cipher   SecretCipher
	// Now：默认 Date.now
	Now func() float64
	// UsageFlushMs：usage 写盘节流，0 = 默认 2000
	UsageFlushMs int
	// OnCall：每次成功调用的明细（UsageCallEvent 形状）；panic 会被吞掉
	OnCall func(e any)
}

// Store：ProviderStore
type Store struct {
	mu        sync.Mutex
	opts      StoreOptions
	now       func() float64
	data      *u.Obj
	side      map[string]*u.Obj // data.routes / data.usage 是数组时，其上的非索引属性（JSON 不输出）
	listeners map[int]func()
	nextL     int
	timer     *time.Timer
}

func emptyUsage() *u.Obj {
	return u.NewObj("requests", 0.0, "errors", 0.0, "inputTokens", 0.0, "outputTokens", 0.0, "totalTokens", 0.0)
}

func dateNow() float64 { return float64(time.Now().UnixMilli()) }

var headerName = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
var httpPrefix = regexp.MustCompile(`(?i)^https?://`)

func sanitizeHeaders(h any) (any, error) {
	if !truthy(h) {
		return undef, nil
	}
	var entries [][2]any
	switch x := h.(type) {
	case *u.Obj:
		for _, k := range x.Keys() {
			v, _ := x.Lookup(k)
			entries = append(entries, [2]any{k, v})
		}
	case []any:
		for i, v := range x {
			entries = append(entries, [2]any{fmt.Sprint(i), v})
		}
	default:
		return undef, nil
	}
	out := u.NewObj()
	for _, e := range entries {
		k := e[0].(string)
		name := u.JSTrim(k)
		if name == "" || !headerName.MatchString(name) {
			return nil, fmt.Errorf("非法 header 名: %s", k)
		}
		s, ok := e[1].(string)
		if !ok {
			continue
		}
		out.Set(name, s)
	}
	if out.Len() > 0 {
		return out, nil
	}
	return undef, nil
}

func normalizeBaseURL(v string) (string, error) {
	s := protocol.TrimBase(v)
	if !httpPrefix.MatchString(s) {
		return "", fmt.Errorf("baseURL 必须以 http(s):// 开头: %s", v)
	}
	return s, nil
}

func randomID8() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// NewStore：new ProviderStore(opts)
func NewStore(opts StoreOptions) *Store {
	s := &Store{opts: opts, now: opts.Now, listeners: map[int]func(){}, side: map[string]*u.Obj{}}
	if s.now == nil {
		s.now = dateNow
	}
	if s.opts.Cipher == nil {
		s.opts.Cipher = PlaintextCipher
	}
	s.data = s.load()
	return s
}

// Encryption：store.encryption
func (s *Store) Encryption() string { return s.opts.Cipher.Kind() }

// ---------------------------------------------------------------- persistence

func emptyData() *u.Obj {
	return u.NewObj("version", 2.0, "providers", []any{}, "routes", u.NewObj(), "usage", u.NewObj())
}

func (s *Store) load() *u.Obj {
	file := s.opts.FilePath
	if file == "" {
		return emptyData()
	}
	if _, err := os.Stat(file); err != nil {
		return emptyData()
	}
	b, err := os.ReadFile(file)
	var raw any
	if err == nil {
		raw, err = u.Parse(b)
	}
	var data *u.Obj
	migrated := false
	if err == nil {
		data, migrated, err = MigrateStoreData(raw)
	}
	if err != nil {
		_ = os.Rename(file, fmt.Sprintf("%s.corrupt-%s", file, u.FormatNumber(s.now())))
		return emptyData()
	}
	if migrated {
		bak := fmt.Sprintf("%s.v%s.bak", file, jsString(orDefault(prop(raw, "version"), 1.0)))
		if src, err := os.ReadFile(file); err == nil {
			if os.WriteFile(bak, src, 0o644) == nil {
				_ = os.Chmod(bak, 0o600)
			}
		}
		s.data = data
		if err := s.persist(); err != nil {
			_ = os.Rename(file, fmt.Sprintf("%s.corrupt-%s", file, u.FormatNumber(s.now())))
			return emptyData()
		}
	}
	return data
}

func orDefault(v, d any) any {
	if nullish(v) {
		return d
	}
	return v
}

func (s *Store) persist() error {
	file := s.opts.FilePath
	if file == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(u.StringifyIndent(s.data, "  ")), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	return nil
}

// commit：persist；成功后返回需通知的监听器（在解锁后调用，等价于 Node 同步回调）
func (s *Store) commit() ([]func(), error) {
	if err := s.persist(); err != nil {
		return nil, err
	}
	ids := make([]int, 0, len(s.listeners))
	for id := range s.listeners {
		ids = append(ids, id)
	}
	sortInts(ids)
	out := make([]func(), 0, len(ids))
	for _, id := range ids {
		out = append(out, s.listeners[id])
	}
	return out, nil
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

func notify(ls []func()) {
	for _, l := range ls {
		func() {
			defer func() { _ = recover() }()
			l()
		}()
	}
}

// OnChange：onChange(listener) → unsubscribe
func (s *Store) OnChange(l func()) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextL
	s.nextL++
	s.listeners[id] = l
	return func() {
		s.mu.Lock()
		delete(s.listeners, id)
		s.mu.Unlock()
	}
}

// Flush：立即写出节流中的 usage
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
		return s.persist()
	}
	return nil
}

// ---------------------------------------------------------------- containers

func (s *Store) providersArr() []any { a, _ := s.data.Get("providers").([]any); return a }

// bagGet / bagSet / bagDelete：data.routes / data.usage 上的 `x[k]`（容器可能是数组）
func (s *Store) bagGet(name, k string) any {
	switch c := s.data.Get(name).(type) {
	case *u.Obj:
		return prop(c, k)
	case []any:
		return prop(s.side[name], k)
	}
	return undef
}

func (s *Store) bagSet(name, k string, v any) {
	switch c := s.data.Get(name).(type) {
	case *u.Obj:
		c.Set(k, v)
	case []any:
		if s.side[name] == nil {
			s.side[name] = u.NewObj()
		}
		s.side[name].Set(k, v)
	}
}

func (s *Store) bagDelete(name, k string) {
	switch c := s.data.Get(name).(type) {
	case *u.Obj:
		c.Delete(k)
	case []any:
		s.side[name].Delete(k)
	}
}

// ---------------------------------------------------------------- queries

func (s *Store) find(id any) *u.Obj {
	for _, p := range s.providersArr() {
		if strictEq(prop(p, "id"), id) {
			return u.AsObj(p)
		}
	}
	return nil
}

func (s *Store) mustGet(id string) (*u.Obj, error) {
	p := s.find(id)
	if p == nil {
		return nil, fmt.Errorf("provider '%s' 不存在", id)
	}
	return p, nil
}

// Has：has(id)
func (s *Store) Has(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.find(id) != nil
}

// Providers：providers()（内部对象，调用方只读）
func (s *Store) Providers() []*u.Obj {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []*u.Obj{}
	for _, p := range s.providersArr() {
		out = append(out, u.AsObj(p))
	}
	return out
}

// ActiveProviderID：activeProviderId()（undefined → u.Undefined）
func (s *Store) ActiveProviderID() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return prop(s.data, "activeProviderId")
}

// Route：route(role)
func (s *Store) Route(role string) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bagGet("routes", role)
}

// Routes：{ ...data.routes }
func (s *Store) Routes() *u.Obj {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.routesLocked()
}

func (s *Store) routesLocked() *u.Obj {
	out := spreadInto(u.NewObj(), s.data.Get("routes"))
	if _, ok := s.data.Get("routes").([]any); ok {
		out.Assign(s.side["routes"])
	}
	return out
}

// ResolveKeys：解密该 provider 的 key（fallback 顺序）。仅供主进程 provider 工厂使用。
func (s *Store) ResolveKeys(id string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.mustGet(id)
	if err != nil {
		return nil, err
	}
	out := []string{}
	keys, _ := p.Get("keys").([]any)
	for _, kv := range keys {
		k, isObj := kv.(*u.Obj)
		if !isObj {
			// Node（严格模式）：读 k.encryption / Buffer.from(undefined) 抛错 → catch 里给原始值赋 lastError 再抛
			if kv == nil {
				return nil, errors.New("Cannot set properties of null (setting 'lastError')")
			}
			if isUndef(kv) {
				return nil, errors.New("Cannot set properties of undefined (setting 'lastError')")
			}
			typ := "object"
			switch kv.(type) {
			case string:
				typ = "string"
			case float64:
				typ = "number"
			case bool:
				typ = "boolean"
			}
			if typ == "object" { // 数组：lastError 落在数组属性上（JSON 不输出）
				continue
			}
			return nil, fmt.Errorf("Cannot create property 'lastError' on %s '%s'", typ, jsString(kv))
		}
		secret, ok := k.Get("secret").(string)
		var plain string
		if ok && strictEq(prop(k, "encryption"), s.opts.Cipher.Kind()) {
			plain, err = s.opts.Cipher.Decrypt(secret)
			ok = err == nil
		} else if ok {
			plain = nodeBase64Decode(secret)
		}
		if !ok {
			k.Set("lastError", "无法解密（系统密钥环可能已变化），请重新填写")
			continue
		}
		out = append(out, plain)
	}
	return out, nil
}

// List：list()
func (s *Store) List() []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked()
}

func (s *Store) listLocked() []any {
	out := []any{}
	for _, p := range s.providersArr() {
		out = append(out, s.view(u.AsObj(p)))
	}
	return out
}

func cloneEach(v any) any {
	arr, ok := v.([]any)
	if !ok {
		if nullish(v) {
			return undef
		}
		return undef
	}
	out := make([]any, len(arr))
	for i, m := range arr {
		out[i] = spreadInto(u.NewObj(), m)
	}
	return out
}

// View：view(p)
func (s *Store) View(p *u.Obj) *u.Obj {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.view(p)
}

func (s *Store) view(p *u.Obj) *u.Obj {
	g := func(k string) any { return prop(p, k) }
	models, _ := p.Get("models").([]any)
	var headers any = undef
	if truthy(g("headers")) {
		headers = spreadInto(u.NewObj(), g("headers"))
	}
	keys := []any{}
	ks, _ := p.Get("keys").([]any)
	for _, k := range ks {
		keys = append(keys, u.NewObj(
			"id", prop(k, "id"),
			"label", prop(k, "label"),
			"masked", prop(k, "masked"),
			"encryption", prop(k, "encryption"),
			"createdAt", prop(k, "createdAt"),
			"lastUsedAt", prop(k, "lastUsedAt"),
			"lastError", prop(k, "lastError"),
		))
	}
	return u.NewObj(
		"id", g("id"),
		"presetId", g("presetId"),
		"name", g("name"),
		"note", g("note"),
		"websiteUrl", g("websiteUrl"),
		"protocol", g("protocol"),
		"baseURL", g("baseURL"),
		"fullUrl", g("fullUrl"),
		"defaultModel", g("defaultModel"),
		"models", append([]any{}, models...),
		"fetchedModels", cloneEach(g("fetchedModels")),
		"fetchedAt", g("fetchedAt"),
		"modelMap", cloneEach(g("modelMap")),
		"headers", headers,
		"userAgent", g("userAgent"),
		"thinking", g("thinking"),
		"enabled", g("enabled"),
		"active", strictEq(prop(s.data, "activeProviderId"), g("id")),
		"keys", keys,
		"usage", spreadInto(emptyUsage(), s.bagGet("usage", jsString(g("id")))),
		"source", "store",
	)
}

// Usage：JSON.parse(JSON.stringify(data.usage))
func (s *Store) Usage() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return jsonClone(s.data.Get("usage"))
}

// ---------------------------------------------------------------- mutations

func uniq(xs any) ([]any, error) {
	arr, ok := xs.([]any)
	if !ok {
		if nullish(xs) {
			return nil, fmt.Errorf("Cannot read properties of %s (reading 'map')", jsString(xs))
		}
		return nil, errors.New("xs.map is not a function")
	}
	seen := map[string]bool{}
	out := []any{}
	trimmed := make([]string, len(arr))
	for i, x := range arr {
		t, err := callTrim(x, "x")
		if err != nil {
			return nil, err
		}
		trimmed[i] = t
	}
	for _, t := range trimmed {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out, nil
}

func sanitizeMap(v any) any {
	arr, ok := v.([]any)
	if !ok {
		return undef
	}
	out := []any{}
	for _, m := range arr {
		from := u.JSTrim(jsString(orDefault(prop(m, "from"), "")))
		to := u.JSTrim(jsString(orDefault(prop(m, "to"), "")))
		if from != "" && to != "" {
			out = append(out, u.NewObj("from", from, "to", to))
		}
	}
	if len(out) > 0 {
		return out
	}
	return undef
}

func strOrUndef(s string) any {
	if s == "" {
		return undef
	}
	return s
}

// applyConfig：把表单输入（部分字段）校验后写进 provider
func applyConfig(p *u.Obj, input *u.Obj) error {
	in := func(k string) any { return prop(input, k) }
	if v := in("name"); !isUndef(v) {
		t, err := callTrim(v, "input.name")
		if err != nil {
			return err
		}
		if t != "" {
			p.Set("name", t)
		} else {
			p.Set("name", prop(p, "name"))
		}
	}
	if v := in("note"); !isUndef(v) {
		t, err := callTrim(v, "input.note")
		if err != nil {
			return err
		}
		p.Set("note", strOrUndef(t))
	}
	if v := in("websiteUrl"); !isUndef(v) {
		w, err := callTrim(v, "input.websiteUrl")
		if err != nil {
			return err
		}
		if w != "" && !httpPrefix.MatchString(w) {
			return fmt.Errorf("官网链接必须以 http(s):// 开头: %s", w)
		}
		p.Set("websiteUrl", strOrUndef(w))
	}
	if v := in("protocol"); !isUndef(v) {
		if !protocol.IsProtocol(v) {
			return fmt.Errorf("未知上游协议: %s", jsString(v))
		}
		p.Set("protocol", v)
	}
	if v := in("baseURL"); !isUndef(v) {
		bs, ok := v.(string)
		if !ok {
			_, err := callTrim(v, "s")
			return err
		}
		b, err := normalizeBaseURL(bs)
		if err != nil {
			return err
		}
		p.Set("baseURL", b)
	}
	if v := in("fullUrl"); !isUndef(v) {
		p.Set("fullUrl", truthy(v))
	}
	if v := in("defaultModel"); !isUndef(v) {
		t, err := callTrim(v, "input.defaultModel")
		if err != nil {
			return err
		}
		if t != "" {
			p.Set("defaultModel", t)
		} else {
			p.Set("defaultModel", prop(p, "defaultModel"))
		}
	}
	if v := in("models"); !isUndef(v) {
		m, err := uniq(v)
		if err != nil {
			return err
		}
		p.Set("models", m)
	}
	if v := in("modelMap"); !isUndef(v) {
		p.Set("modelMap", sanitizeMap(v))
	}
	if arr, ok := in("fetchedModels").([]any); ok {
		out := []any{}
		for _, m := range arr {
			id, ok := prop(m, "id").(string)
			if !truthy(m) || !ok || u.JSTrim(id) == "" {
				continue
			}
			o := u.NewObj("id", u.JSTrim(id))
			if n := prop(m, "name"); truthy(n) {
				o.Set("name", jsString(n))
			}
			out = append(out, o)
		}
		p.Set("fetchedModels", out)
		p.Set("fetchedAt", dateNow())
	}
	if v := in("headers"); !isUndef(v) {
		h, err := sanitizeHeaders(v)
		if err != nil {
			return err
		}
		p.Set("headers", h)
	}
	if v := in("userAgent"); !isUndef(v) {
		t, err := callTrim(v, "input.userAgent")
		if err != nil {
			return err
		}
		p.Set("userAgent", strOrUndef(t))
	}
	if v := in("thinking"); !isUndef(v) {
		if truthy(v) {
			p.Set("thinking", true)
		} else {
			p.Set("thinking", undef)
		}
	}
	ensureDefaultFirst(p)
	return nil
}

// `if (p.defaultModel && !p.models.includes(p.defaultModel)) p.models.unshift(p.defaultModel)`
func ensureDefaultFirst(p *u.Obj) {
	dm := prop(p, "defaultModel")
	models, _ := p.Get("models").([]any)
	if truthy(dm) && !includes(models, dm) {
		p.Set("models", append([]any{dm}, models...))
	}
}

func (s *Store) makeKey(plain any, label any) (*u.Obj, error) {
	key, err := callTrim(plain, "plain")
	if err != nil {
		return nil, err
	}
	if key == "" {
		return nil, errors.New("API key 不能为空")
	}
	if hasJSWhitespace(key) {
		return nil, errors.New("API key 不能包含空白字符")
	}
	id := "k-" + randomID8()
	lbl, err := optTrim(label, "label")
	if err != nil {
		return nil, err
	}
	if !truthy(lbl) {
		lbl = undef
	}
	secret, err := s.opts.Cipher.Encrypt(key)
	if err != nil {
		return nil, err
	}
	return u.NewObj(
		"id", id,
		"label", lbl,
		"secret", secret,
		"encryption", s.opts.Cipher.Kind(),
		"masked", MaskSecret(key),
		"createdAt", s.now(),
	), nil
}

// Upsert：upsert(input)
func (s *Store) Upsert(input *u.Obj) (*u.Obj, error) {
	s.mu.Lock()
	v, ls, err := s.upsert(input)
	s.mu.Unlock()
	notify(ls)
	return v, err
}

func (s *Store) upsert(input *u.Obj) (*u.Obj, []func(), error) {
	if input == nil {
		return nil, nil, errors.New("Cannot read properties of undefined (reading 'id')")
	}
	ts := s.now()
	in := func(k string) any { return prop(input, k) }
	var existing *u.Obj
	if truthy(in("id")) {
		existing = s.find(in("id"))
	}
	if existing != nil {
		if err := applyConfig(existing, input); err != nil {
			return nil, nil, err
		}
		if v := in("enabled"); !isUndef(v) {
			existing.Set("enabled", truthy(v))
		}
		ak, err := optTrim(in("apiKey"), "input.apiKey")
		if err != nil {
			return nil, nil, err
		}
		if truthy(ak) {
			k, err := s.makeKey(in("apiKey"), undef)
			if err != nil {
				return nil, nil, err
			}
			keys, _ := existing.Get("keys").([]any)
			existing.Set("keys", append([]any{k}, keys...))
		}
		existing.Set("updatedAt", ts)
		ls, err := s.commit()
		if err != nil {
			return nil, nil, err
		}
		return s.view(existing), ls, nil
	}
	preset := FindPreset(in("presetId"))
	if preset == nil {
		preset = FindPreset("custom")
	}
	baseURL := orDefault(in("baseURL"), prop(preset, "baseURL"))
	bt, err := callTrim(baseURL, "baseURL")
	if err != nil {
		return nil, nil, err
	}
	if bt == "" {
		return nil, nil, errors.New("请填写 API 请求地址")
	}
	dm, err := optTrim(in("defaultModel"), "input.defaultModel")
	if err != nil {
		return nil, nil, err
	}
	var defaultModel any = dm
	if !truthy(defaultModel) {
		defaultModel = prop(preset, "defaultModel")
		if !truthy(defaultModel) {
			defaultModel = ""
		}
	}
	id := fmt.Sprintf("p-%s-%s", jsString(prop(preset, "id")), randomID8())
	nm, err := optTrim(in("name"), "input.name")
	if err != nil {
		return nil, nil, err
	}
	var name any = nm
	if !truthy(name) {
		name = prop(preset, "name")
	}
	nb, err := normalizeBaseURL(baseURL.(string))
	if err != nil {
		return nil, nil, err
	}
	keys := []any{}
	ak, err := optTrim(in("apiKey"), "input.apiKey")
	if err != nil {
		return nil, nil, err
	}
	if truthy(ak) {
		k, err := s.makeKey(in("apiKey"), undef)
		if err != nil {
			return nil, nil, err
		}
		keys = []any{k}
	}
	created := u.NewObj(
		"id", id,
		"presetId", prop(preset, "id"),
		"name", name,
		"protocol", prop(preset, "protocol"),
		"baseURL", nb,
		"fullUrl", false,
		"defaultModel", defaultModel,
		"models", []any{},
		"websiteUrl", prop(preset, "websiteUrl"),
		"enabled", orDefault(in("enabled"), true),
		"keys", keys,
		"createdAt", ts,
		"updatedAt", ts,
	)
	if err := applyConfig(created, input.Clone().Set("baseURL", baseURL)); err != nil {
		return nil, nil, err
	}
	if m, _ := created.Get("models").([]any); len(m) == 0 && truthy(prop(created, "defaultModel")) {
		created.Set("models", []any{prop(created, "defaultModel")})
	}
	s.data.Set("providers", append(s.providersArr(), created))
	ls, err := s.commit()
	if err != nil {
		return nil, nil, err
	}
	return s.view(created), ls, nil
}

// SetModels：setModels(id, { fetched?, enabled? })
func (s *Store) SetModels(id string, patch *u.Obj) (*u.Obj, error) {
	s.mu.Lock()
	v, ls, err := s.setModels(id, patch)
	s.mu.Unlock()
	notify(ls)
	return v, err
}

func (s *Store) setModels(id string, patch *u.Obj) (*u.Obj, []func(), error) {
	p, err := s.mustGet(id)
	if err != nil {
		return nil, nil, err
	}
	if f := prop(patch, "fetched"); truthy(f) {
		arr, ok := f.([]any)
		if !ok {
			return nil, nil, errors.New("patch.fetched.map is not a function")
		}
		out := make([]any, len(arr))
		for i, m := range arr {
			out[i] = spreadInto(u.NewObj(), m)
		}
		p.Set("fetchedModels", out)
		p.Set("fetchedAt", s.now())
	}
	if e := prop(patch, "enabled"); truthy(e) {
		m, err := uniq(e)
		if err != nil {
			return nil, nil, err
		}
		p.Set("models", m)
	}
	ensureDefaultFirst(p)
	p.Set("updatedAt", s.now())
	ls, err := s.commit()
	if err != nil {
		return nil, nil, err
	}
	return s.view(p), ls, nil
}

// Remove：remove(id)
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	ls, err := s.remove(id)
	s.mu.Unlock()
	notify(ls)
	return err
}

func (s *Store) remove(id string) ([]func(), error) {
	if _, err := s.mustGet(id); err != nil {
		return nil, err
	}
	kept := []any{}
	for _, p := range s.providersArr() {
		if !strictEq(prop(p, "id"), id) {
			kept = append(kept, p)
		}
	}
	s.data.Set("providers", kept)
	if strictEq(prop(s.data, "activeProviderId"), id) {
		s.data.Set("activeProviderId", undef)
	}
	for _, role := range ProviderRoles {
		if strictEq(prop(s.bagGet("routes", role), "providerId"), id) {
			s.bagDelete("routes", role)
		}
	}
	s.bagDelete("usage", id)
	return s.commit()
}

// SetActive：setActive(id | undefined, model?)；id 为 u.Undefined 表示回到环境变量默认
func (s *Store) SetActive(id any, model any) error {
	s.mu.Lock()
	ls, err := s.setActive(id, model)
	s.mu.Unlock()
	notify(ls)
	return err
}

func (s *Store) setActive(id any, model any) ([]func(), error) {
	var p *u.Obj
	if !isUndef(id) {
		p = s.find(id)
	}
	if p != nil && !truthy(prop(p, "enabled")) {
		p.Set("enabled", true)
	}
	if p != nil {
		mt, err := optTrim(model, "model")
		if err != nil {
			return nil, err
		}
		if truthy(mt) {
			p.Set("defaultModel", mt)
			models, _ := p.Get("models").([]any)
			if !includes(models, mt) {
				p.Set("models", append(models, mt))
			}
		}
	}
	s.data.Set("activeProviderId", id)
	s.bagDelete("routes", "chat")
	return s.commit()
}

func validRole(role any) bool {
	for _, r := range ProviderRoles {
		if strictEq(role, r) {
			return true
		}
	}
	return false
}

// SetRoute：setRoute(role, binding | null)
func (s *Store) SetRoute(role any, binding any) error {
	s.mu.Lock()
	ls, err := s.setRoute(role, binding)
	s.mu.Unlock()
	notify(ls)
	return err
}

func (s *Store) setRoute(role any, binding any) ([]func(), error) {
	if !validRole(role) {
		return nil, fmt.Errorf("未知 role: %s", jsString(role))
	}
	r := role.(string)
	if binding == nil {
		s.bagDelete("routes", r)
	} else {
		if isUndef(binding) {
			return nil, errors.New("Cannot read properties of undefined (reading 'providerId')")
		}
		if !truthy(prop(binding, "providerId")) {
			s.bagDelete("routes", r)
		} else {
			mt, err := optTrim(prop(binding, "model"), "binding.model")
			if err != nil {
				return nil, err
			}
			if !truthy(mt) {
				mt = undef
			}
			s.bagSet("routes", r, u.NewObj("providerId", prop(binding, "providerId"), "model", mt))
		}
	}
	return s.commit()
}

func (s *Store) keyMutation(id string, f func(p *u.Obj, keys []any) ([]any, error)) (*u.Obj, error) {
	s.mu.Lock()
	var ls []func()
	v, err := func() (*u.Obj, error) {
		p, err := s.mustGet(id)
		if err != nil {
			return nil, err
		}
		keys, _ := p.Get("keys").([]any)
		next, err := f(p, keys)
		if err != nil {
			return nil, err
		}
		p.Set("keys", next)
		p.Set("updatedAt", s.now())
		ls, err = s.commit()
		if err != nil {
			return nil, err
		}
		return s.view(p), nil
	}()
	s.mu.Unlock()
	notify(ls)
	return v, err
}

func keyIndex(keys []any, keyID any) int {
	for i, k := range keys {
		if strictEq(prop(k, "id"), keyID) {
			return i
		}
	}
	return -1
}

// AddKey：addKey(id, plain, label?)
func (s *Store) AddKey(id string, plain any, label any) (*u.Obj, error) {
	return s.keyMutation(id, func(_ *u.Obj, keys []any) ([]any, error) {
		k, err := s.makeKey(plain, label)
		if err != nil {
			return nil, err
		}
		return append(keys, k), nil
	})
}

// RotateKey：用新值替换某个 key（保留位置与标签）
func (s *Store) RotateKey(id string, keyID any, plain any) (*u.Obj, error) {
	return s.keyMutation(id, func(_ *u.Obj, keys []any) ([]any, error) {
		idx := keyIndex(keys, keyID)
		if idx < 0 {
			return nil, fmt.Errorf("key '%s' 不存在", jsString(keyID))
		}
		next, err := s.makeKey(plain, prop(keys[idx], "label"))
		if err != nil {
			return nil, err
		}
		out := append([]any{}, keys...)
		out[idx] = next
		return out, nil
	})
}

// RemoveKey：removeKey(id, keyId)
func (s *Store) RemoveKey(id string, keyID any) (*u.Obj, error) {
	return s.keyMutation(id, func(p *u.Obj, keys []any) ([]any, error) {
		out := []any{}
		for _, k := range keys {
			if !strictEq(prop(k, "id"), keyID) {
				out = append(out, k)
			}
		}
		// Node 先赋值 p.keys 再判断长度
		p.Set("keys", out)
		if len(out) == len(keys) {
			return nil, fmt.Errorf("key '%s' 不存在", jsString(keyID))
		}
		return out, nil
	})
}

// PromoteKey：设为主 key
func (s *Store) PromoteKey(id string, keyID any) (*u.Obj, error) {
	return s.keyMutation(id, func(_ *u.Obj, keys []any) ([]any, error) {
		idx := keyIndex(keys, keyID)
		if idx < 0 {
			return nil, fmt.Errorf("key '%s' 不存在", jsString(keyID))
		}
		out := []any{keys[idx]}
		for i, k := range keys {
			if i != idx && k != keys[idx] {
				out = append(out, k)
			}
		}
		return out, nil
	})
}

// MarkKey：key 调用结果（不触发 onChange）；errMsg 为 u.Undefined / "" 表示成功
func (s *Store) MarkKey(id string, idx any, errMsg any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.find(id)
	if p == nil {
		return
	}
	keys, _ := p.Get("keys").([]any)
	n, ok := idx.(float64)
	if !ok || n != float64(int(n)) || n < 0 || int(n) >= len(keys) {
		return
	}
	k, ok := keys[int(n)].(*u.Obj)
	if !ok {
		return
	}
	k.Set("lastUsedAt", s.now())
	if truthy(errMsg) {
		k.Set("lastError", u.UTF16Slice0(jsString(errMsg), 200))
	} else {
		k.Set("lastError", undef)
	}
	s.scheduleUsageFlush()
}

func addNum(o *u.Obj, k string, d any) {
	o.Set(k, jsAdd(prop(o, k), d))
}

// jsAdd：a + b（用量计数；字符串参与时按 JS 拼接）
func jsAdd(a, b any) any {
	_, as := a.(string)
	_, bs := b.(string)
	if as || bs {
		return jsString(a) + jsString(b)
	}
	return jsNumber(a) + jsNumber(b)
}

// RecordUsage：recordUsage(id, u?, ok)
func (s *Store) RecordUsage(id string, usage any, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := spreadInto(emptyUsage(), s.bagGet("usage", id))
	addNum(cur, "requests", 1.0)
	if !ok {
		addNum(cur, "errors", 1.0)
	}
	in := orDefault(prop(usage, "inputTokens"), 0.0)
	out := orDefault(prop(usage, "outputTokens"), 0.0)
	addNum(cur, "inputTokens", in)
	addNum(cur, "outputTokens", out)
	addNum(cur, "totalTokens", orDefault(prop(usage, "totalTokens"), jsAdd(in, out)))
	cur.Set("lastUsedAt", s.now())
	s.bagSet("usage", id, cur)
	s.scheduleUsageFlush()
}

// RecordCall：recordCall(e)；回调 panic 被吞掉
func (s *Store) RecordCall(e any) {
	if s.opts.OnCall == nil {
		return
	}
	defer func() { _ = recover() }()
	s.opts.OnCall(e)
}

// ResetUsage：resetUsage(id?)
func (s *Store) ResetUsage(id any) error {
	s.mu.Lock()
	var ls []func()
	var err error
	if truthy(id) {
		s.bagDelete("usage", jsString(id))
	} else {
		s.data.Set("usage", u.NewObj())
		delete(s.side, "usage")
	}
	ls, err = s.commit()
	s.mu.Unlock()
	notify(ls)
	return err
}

func (s *Store) scheduleUsageFlush() {
	if s.opts.FilePath == "" || s.timer != nil {
		return
	}
	ms := s.opts.UsageFlushMs
	if ms == 0 {
		ms = 2000
	}
	s.timer = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.timer = nil
		_ = s.persist()
	})
}

// ---------------------------------------------------------------- migration

var renamedPresets = map[string]string{"claude": "anthropic", "moonshot": "kimi"}
var openaiSuffix = regexp.MustCompile(`/openai$`)

// migrateProvider：v1 `backend` → v2 `protocol`
func migrateProvider(raw any) (*u.Obj, error) {
	if raw == nil || isUndef(raw) {
		return nil, fmt.Errorf("Cannot read properties of %s (reading 'backend')", jsString(raw))
	}
	r := func(k string) any { return prop(raw, k) }
	backend := jsString(orDefault(r("backend"), "openai-compatible"))
	var proto any
	switch {
	case protocol.IsProtocol(r("protocol")):
		proto = r("protocol")
	case backend == "anthropic":
		proto = "anthropic"
	default:
		proto = "openai-chat"
	}
	baseURL := jsString(orDefault(r("baseURL"), ""))
	if !protocol.IsProtocol(r("protocol")) && backend == "google" {
		proto = "openai-chat"
		if !openaiSuffix.MatchString(protocol.TrimBase(baseURL)) {
			baseURL = protocol.TrimBase(baseURL) + "/openai"
		}
	}
	presetID := jsString(orDefault(r("presetId"), "custom"))
	if n, ok := renamedPresets[presetID]; ok {
		presetID = n
	}
	defaultModel := u.JSTrim(jsString(orDefault(r("defaultModel"), "")))
	var models []any
	if arr, ok := r("models").([]any); ok {
		strs := []any{}
		for _, m := range arr {
			if s := jsString(m); s != "" {
				strs = append(strs, s)
			}
		}
		models, _ = uniq(strs)
	} else if defaultModel != "" {
		models = []any{defaultModel}
	} else {
		models = []any{}
	}
	if defaultModel != "" && !includes(models, defaultModel) {
		models = append([]any{defaultModel}, models...)
	}
	rest := spreadInto(u.NewObj(), raw)
	rest.Delete("backend")
	websiteURL := r("websiteUrl")
	if nullish(websiteURL) {
		websiteURL = prop(FindPreset(presetID), "websiteUrl")
	}
	keys, ok := r("keys").([]any)
	if !ok {
		keys = []any{}
	}
	return rest.
		Set("presetId", presetID).
		Set("protocol", proto).
		Set("baseURL", protocol.TrimBase(baseURL)).
		Set("fullUrl", truthy(r("fullUrl"))).
		Set("defaultModel", defaultModel).
		Set("models", models).
		Set("websiteUrl", websiteURL).
		Set("keys", keys).
		Set("enabled", !strictEq(r("enabled"), false)), nil
}

// MigrateStoreData：读入任意版本的 ai-providers.json → v2（raw 会被就地修改，与 Node 一致）
func MigrateStoreData(raw any) (*u.Obj, bool, error) {
	if raw == nil || isUndef(raw) {
		return nil, false, fmt.Errorf("Cannot read properties of %s (reading 'version')", jsString(raw))
	}
	version := jsNumber(orDefault(prop(raw, "version"), 1.0))
	providers := []any{}
	if arr, ok := prop(raw, "providers").([]any); ok {
		for _, p := range arr {
			mp, err := migrateProvider(p)
			if err != nil {
				return nil, false, err
			}
			providers = append(providers, mp)
		}
	}
	var routes any = u.NewObj()
	if rv := prop(raw, "routes"); truthy(rv) {
		switch rv.(type) {
		case *u.Obj, []any:
			routes = rv
		}
	}
	activeProviderID := prop(raw, "activeProviderId")
	if ro, ok := routes.(*u.Obj); ok && version < 2 && truthy(prop(ro, "chat")) {
		chat := prop(ro, "chat")
		if chat == nil {
			return nil, false, errors.New("Cannot read properties of null (reading 'providerId')")
		}
		activeProviderID = prop(chat, "providerId")
		for _, pv := range providers {
			p := pv.(*u.Obj)
			if strictEq(prop(p, "id"), prop(chat, "providerId")) {
				if m := prop(chat, "model"); truthy(m) {
					p.Set("defaultModel", m)
					models, _ := p.Get("models").([]any)
					if !includes(models, m) {
						p.Set("models", append([]any{m}, models...))
					}
				}
				break
			}
		}
		ro.Delete("chat")
	}
	var usage any = u.NewObj()
	if uv := prop(raw, "usage"); truthy(uv) {
		switch uv.(type) {
		case *u.Obj, []any:
			usage = uv
		}
	}
	return u.NewObj(
		"version", 2.0,
		"providers", providers,
		"activeProviderId", activeProviderID,
		"routes", routes,
		"usage", usage,
	), version < 2, nil
}
