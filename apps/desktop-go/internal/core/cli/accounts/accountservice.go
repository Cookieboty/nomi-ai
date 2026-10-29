package accounts

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
)

const (
	storeFile       = "accounts.json"
	sessionsFile    = "session-accounts.json"
	maxSessions     = 5000
	logoutTimeoutMs = 20_000
)

var terminals = map[string]*clisdk.TerminalCapability{
	"claude": claude.CreateMain().Terminal, "codex": codex.CreateMain().Terminal,
	"grok": grok.CreateMain().Terminal, "gemini": gemini.CreateMain().Terminal,
}

// AccountError = AccountError（Code: not-found / in-use / local / unsupported / unknown-live）。
type AccountError struct{ Code, Message string }

func (e *AccountError) Error() string { return e.Message }

func accountErr(code, msg string) *AccountError { return &AccountError{code, msg} }

// LocalAccountID = localAccountId.
func LocalAccountID(kind string) string { return "local-" + kind }

// ServiceDeps = AccountService 的构造参数（nil / 零值 = 未注入）。
type ServiceDeps struct {
	Root             string
	Logger           deps.Logger
	Events           deps.Events
	Env              *util.Obj
	Home             string
	Platform         string
	Keychain         KeychainAdapter
	Identity         *IdentityDeps
	Now              func() float64
	OnDefaultChanged func(kind string)
	// InUse 返回 nil = undefined
	InUse         func(kind, accountID string) any
	OnChanged     func()
	Logout        func(kind string, env *util.Obj) error
	LiveProcesses func(kind, dir string) (LiveCheck, error)
}

type storeT struct {
	accounts []any
	defaults any
	// 数组形 defaults 上的非下标属性（JSON.stringify 不输出）
	hidden map[string]any
}

type sessionMapT struct {
	keys []string
	m    map[string]string
}

func (s *sessionMapT) del(k string) {
	if _, ok := s.m[k]; !ok {
		return
	}
	delete(s.m, k)
	for i, x := range s.keys {
		if x == k {
			s.keys = append(s.keys[:i], s.keys[i+1:]...)
			break
		}
	}
}

func (s *sessionMapT) set(k, v string) {
	if _, ok := s.m[k]; !ok {
		s.keys = append(s.keys, k)
	}
	s.m[k] = v
}

// AccountService = AccountService（所有方法持 jsrt 锁调用）。
type AccountService struct {
	d        ServiceDeps
	data     *storeT
	sessions *sessionMapT
}

// NewAccountService = new AccountService(d)（mkdirSync root）。
func NewAccountService(d ServiceDeps) (*AccountService, error) {
	if err := os.MkdirAll(d.Root, 0o777); err != nil {
		return nil, jsThrow("Error", nodefs.Message(err, "mkdir", d.Root))
	}
	return &AccountService{d: d}, nil
}

func (s *AccountService) now() float64 {
	if s.d.Now != nil {
		return s.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (s *AccountService) env() *util.Obj {
	if s.d.Env != nil {
		return s.d.Env
	}
	return usage.ProcessEnv()
}

func (s *AccountService) file() string { return filepath.Join(s.d.Root, storeFile) }

func (s *AccountService) platform() string {
	if s.d.Platform != "" {
		return s.d.Platform
	}
	return usage.Platform()
}

/* ------------------------------ record helpers ------------------------------ */

// setProp = a[k] = v（严格模式：原始值上抛 TypeError）。
func setProp(a any, k string, v any) {
	switch x := a.(type) {
	case *util.Obj:
		x.Set(k, v)
		return
	case []any:
		return // 不会出现：记录是数组时属性不进 JSON（Node 同样丢弃）
	case nil:
		panic(typeErr("Cannot set properties of null (setting '" + k + "')"))
	case util.JSUndefined:
		panic(typeErr("Cannot set properties of undefined (setting '" + k + "')"))
	case string:
		panic(typeErr("Cannot create property '" + k + "' on string '" + x + "'"))
	case float64:
		panic(typeErr("Cannot create property '" + k + "' on number '" + jsStr(x) + "'"))
	case bool:
		panic(typeErr("Cannot create property '" + k + "' on boolean '" + jsStr(x) + "'"))
	}
}

func delProp(a any, k string) {
	switch x := a.(type) {
	case *util.Obj:
		x.Delete(k)
	case nil:
		panic(typeErr("Cannot convert undefined or null to object"))
	}
}

// dirOf = a.dir（nil = null / undefined；只认字符串目录）。
func dirOf(a any) *string {
	v := prop(a, "dir")
	switch x := v.(type) {
	case string:
		return &x
	case nil, util.JSUndefined:
		return nil
	}
	panic(typeErr(`The "path" argument must be of type string. Received ` + describeArg(v)))
}

func describeArg(v any) string {
	switch x := v.(type) {
	case float64:
		return "type number (" + jsStr(x) + ")"
	case bool:
		return "type boolean (" + jsStr(x) + ")"
	case []any:
		return "an instance of Array"
	}
	return "an instance of Object"
}

func hasDir(p *string) bool { return p != nil && *p != "" }

func kindOf(a any) string { k, _ := prop(a, "kind").(string); return k }

// primaryKey = key.split('|')[0].
func primaryKey(key any) string {
	switch x := key.(type) {
	case string:
		return strings.SplitN(x, "|", 2)[0]
	case nil:
		panic(typeErr("Cannot read properties of null (reading 'split')"))
	case util.JSUndefined:
		panic(typeErr("Cannot read properties of undefined (reading 'split')"))
	}
	panic(typeErr("key.split is not a function"))
}

func t(key string, args ...any) string { return i18n.T(key, args...) }

/* --------------------------------- store --------------------------------- */

func (s *AccountService) store() *storeT {
	if s.data != nil {
		return s.data
	}
	st := &storeT{accounts: []any{}, defaults: util.NewObj()}
	if b, err := os.ReadFile(s.file()); err == nil {
		if raw, err := parseJSON(string(b)); err == nil && !nullish(raw) {
			if prop(raw, "version") == float64(2) {
				if arr, ok := prop(raw, "accounts").([]any); ok {
					st.accounts = arr
					st.defaults = orElse(prop(raw, "defaults"), util.NewObj())
				}
			}
		}
	}
	for _, kind := range AccountKinds {
		id := LocalAccountID(kind)
		found := false
		for _, a := range st.accounts {
			if prop(a, "id") == id {
				found = true
				break
			}
		}
		if !found {
			rec := util.NewObj("id", id, "kind", kind, "label", t("electron.common.this-computer-s-sign-in"),
				"dir", nil, "identity", nil, "loggedIn", false, "createdAt", s.now())
			st.accounts = append([]any{rec}, st.accounts...)
		}
	}
	s.data = st
	s.migrateVault()
	return st
}

func (st *storeT) json() string {
	return util.StringifyIndent(util.NewObj("version", float64(2), "accounts", st.accounts, "defaults", st.defaults), "  ")
}

func (st *storeT) getDefault(kind string) any {
	switch x := st.defaults.(type) {
	case *util.Obj:
		if v, ok := x.Lookup(kind); ok {
			return v
		}
		return undef
	case []any:
		if v, ok := st.hidden[kind]; ok {
			return v
		}
	}
	return undef
}

func (st *storeT) setDefault(kind, id string) {
	switch x := st.defaults.(type) {
	case *util.Obj:
		x.Set(kind, id)
	case []any:
		if st.hidden == nil {
			st.hidden = map[string]any{}
		}
		st.hidden[kind] = id
	default:
		setProp(x, kind, id)
	}
}

func (st *storeT) deleteDefault(kind string) {
	switch x := st.defaults.(type) {
	case *util.Obj:
		x.Delete(kind)
	case []any:
		delete(st.hidden, kind)
	}
}

func (s *AccountService) save() {
	if err := utils.WritePrivateFileAtomicNode(s.file(), []byte(s.store().json())); err != nil {
		panic(err)
	}
	if s.d.OnChanged != nil {
		s.d.OnChanged()
	}
}

var (
	vaultEmailRe = util.JSRe(`"email(?:Address)?"\s*:\s*"([^"]+)"`)
	vaultLabelRe = util.JSRe(`"label"\s*:\s*"([^"]+)"`)
)

func (s *AccountService) warn(msg string, data any) {
	if s.d.Logger != nil {
		s.d.Logger.Warn(msg, data)
	}
}

func (s *AccountService) info(msg string, data any) {
	if s.d.Logger != nil {
		s.d.Logger.Info(msg, data)
	}
}

// iterate = for (const a of v)（字符串按码点；不可迭代抛 TypeError）。
func iterate(v any, expr string, fn func(any)) {
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			fn(e)
		}
	case string:
		for _, r := range x {
			fn(string(r))
		}
	case nil, util.JSUndefined:
		panic(typeErr(expr + " is not iterable"))
	case float64:
		panic(typeErr("number " + util.JSString(x) + " is not iterable (cannot read property Symbol(Symbol.iterator))"))
	case bool:
		panic(typeErr("boolean " + util.JSString(x) + " is not iterable (cannot read property Symbol(Symbol.iterator))"))
	default:
		// `raw.accounts ?? []`：V8 对非简单引用报 `<typeof> … (cannot read property Symbol(Symbol.iterator))`
		panic(typeErr("object is not iterable (cannot read property Symbol(Symbol.iterator))"))
	}
}

func (s *AccountService) migrateVault() {
	st := s.data
	beforeLen := len(st.accounts)
	migrated := 0
	var pendingDelete, pendingArchive []string
	for _, kind := range AccountKinds {
		legacy := filepath.Join(s.d.Root, kind+".json")
		if !usage.ExistsSync(legacy) {
			continue
		}
		var perr error
		func() {
			defer catchJS(&perr)
			b, err := os.ReadFile(legacy)
			if err != nil {
				panic(jsThrow("Error", nodefs.ReadFileError(err, legacy)))
			}
			raw, err := parseJSON(string(b))
			if err != nil {
				panic(err)
			}
			list := orElse(prop(raw, "accounts"), []any{})
			iterate(list, "raw.accounts", func(a any) {
				id := uuid.NewString()
				label := jsStr(orElse(prop(a, "label"), orElse(opt(prop(a, "identity"), "email"), t("electron.common.official-account"))))
				st.accounts = append(st.accounts, util.NewObj(
					"id", id, "kind", kind, "label", slice16(label, 0, 60),
					"dir", AccountDirFor(s.d.Root, kind, id),
					"identity", orElse(prop(a, "identity"), nil),
					"loggedIn", false, "needsLogin", true,
					"createdAt", orElse(prop(a, "createdAt"), s.now())))
				migrated++
			})
			pendingDelete = append(pendingDelete, legacy)
		}()
		if perr == nil {
			continue
		}
		s.warn("legacy account vault unreadable; will archive after stubs", util.NewObj("kind", kind, "error", errString(perr)))
		if b, err := os.ReadFile(legacy); err == nil {
			blob := string(b)
			var emails, labels []string
			for _, m := range vaultEmailRe.FindAllStringSubmatch(blob, -1) {
				emails = append(emails, m[1])
			}
			for _, m := range vaultLabelRe.FindAllStringSubmatch(blob, -1) {
				labels = append(labels, m[1])
			}
			n := max(len(emails), len(labels))
			for i := 0; i < n; i++ {
				id := uuid.NewString()
				email := ""
				if i < len(emails) {
					email = emails[i]
				}
				var label string
				switch {
				case i < len(labels):
					label = labels[i]
				case email != "":
					label = email
				default:
					label = t("electron.common.official-account")
				}
				var ident any
				if email != "" {
					ident = util.NewObj("key", email, "email", email)
				}
				st.accounts = append(st.accounts, util.NewObj(
					"id", id, "kind", kind, "label", slice16(label, 0, 60),
					"dir", AccountDirFor(s.d.Root, kind, id), "identity", ident,
					"loggedIn", false, "needsLogin", true, "createdAt", s.now()))
				migrated++
			}
		}
		pendingArchive = append(pendingArchive, legacy)
	}
	if len(pendingDelete) == 0 && len(pendingArchive) == 0 {
		return
	}
	if migrated > 0 || len(pendingDelete) > 0 {
		if err := utils.WritePrivateFileAtomicNode(s.file(), []byte(st.json())); err != nil {
			st.accounts = st.accounts[:beforeLen]
			s.warn("legacy vault migration write failed; vault kept", errString(err))
			return
		}
	}
	for _, f := range pendingDelete {
		_ = os.Remove(f)
	}
	for _, f := range pendingArchive {
		base := strings.TrimSuffix(filepath.Base(f), ".json")
		archive := filepath.Join(s.d.Root, "vault-unreadable", base+"-"+jsStr(s.now())+".json")
		if err := os.MkdirAll(filepath.Dir(archive), 0o777); err != nil {
			s.warn("legacy vault left in place (archive failed)", util.NewObj("file", f, "error", "Error: "+nodefs.Message(err, "mkdir", filepath.Dir(archive))))
			continue
		}
		if err := os.Rename(f, archive); err != nil {
			s.warn("legacy vault left in place (archive failed)", util.NewObj("file", f, "error", "Error: "+nodefs.Message(err, "rename", f, archive)))
			continue
		}
		s.warn("legacy vault archived (unreadable, not deleted)", util.NewObj("archive", archive))
	}
	if migrated > 0 || len(pendingDelete) > 0 {
		for _, dir := range []string{"backups", "staging"} {
			_ = nodefs.RmForce(filepath.Join(s.d.Root, dir))
		}
	}
	if migrated > 0 {
		s.info("legacy account vault migrated (credentials removed)", util.NewObj("migrated", float64(migrated)))
	}
}

func (s *AccountService) find(id string) any {
	for _, a := range s.store().accounts {
		if prop(a, "id") == id {
			return a
		}
	}
	panic(accountErr("not-found", t("electron.common.account-not-found")))
}

func (s *AccountService) defaultID(kind string) string {
	st := s.store()
	id := st.getDefault(kind)
	if truthy(id) {
		for _, a := range st.accounts {
			if prop(a, "id") == id && prop(a, "kind") == kind {
				return id.(string)
			}
		}
	}
	return LocalAccountID(kind)
}

// DefaultID = defaultId.
func (s *AccountService) DefaultID(kind string) (id string, err error) {
	defer catchJS(&err)
	return s.defaultID(kind), nil
}

// DefaultDir = defaultDir（nil = null）。
func (s *AccountService) DefaultDir(kind string) (dir any, err error) {
	defer catchJS(&err)
	def := s.defaultID(kind)
	for _, a := range s.store().accounts {
		if prop(a, "id") == def {
			return orElse(prop(a, "dir"), nil), nil
		}
	}
	return nil, nil
}

func problemsJSON(ps []HomeProblem) []any {
	out := make([]any, len(ps))
	for i, p := range ps {
		out[i] = util.NewObj("entry", p.Entry, "reason", p.Reason)
	}
	return out
}

func (s *AccountService) ensureHome(kind string, dir string) []HomeProblem {
	ps, err := EnsureAccountHome(kind, dir, UserCliHome(kind, s.env(), s.d.Home), s.d.Platform)
	if err != nil {
		panic(err)
	}
	return ps
}

func (s *AccountService) inUse(kind string, id any) any {
	if s.d.InUse == nil {
		return float64(0)
	}
	idS, _ := id.(string)
	return orElse(s.d.InUse(kind, idS), float64(0))
}

func (s *AccountService) view(a any) *util.Obj {
	kind := kindOf(a)
	dir := dirOf(a)
	var problems []HomeProblem
	if hasDir(dir) {
		problems = s.ensureHome(kind, *dir)
		if len(problems) > 0 {
			s.warn("account home shared entries not linked", util.NewObj("kind", prop(a, "kind"), "id", prop(a, "id"), "problems", problemsJSON(problems)))
		} else {
			problems = nil
		}
	}
	v := util.NewObj("id", prop(a, "id"), "kind", prop(a, "kind"), "label", prop(a, "label"),
		"identity", prop(a, "identity"),
		"active", s.defaultID(kind) == prop(a, "id"),
		"local", prop(a, "dir") == nil,
		"loggedIn", prop(a, "loggedIn"))
	if truthy(prop(a, "needsLogin")) {
		v.Set("needsLogin", true)
	}
	v.Set("inUse", s.inUse(kind, prop(a, "id")))
	v.Set("duplicateOf", s.duplicateOf(a))
	if hasDir(dir) {
		v.Set("terminalCommand", s.terminalCommand(kind, *dir))
	}
	if len(problems) > 0 {
		v.Set("problems", problemsJSON(problems))
	}
	v.Set("createdAt", prop(a, "createdAt"))
	if lu := prop(a, "lastUsedAt"); truthy(lu) {
		v.Set("lastUsedAt", lu)
	}
	return v
}

func (s *AccountService) terminalCommand(kind, dir string) string {
	tc := terminals[kind]
	if tc == nil {
		panic(typeErr("Cannot read properties of undefined (reading 'command')"))
	}
	cmd := tc.Command("", nil, util.NewObj())
	return shared.TerminalLine(cmd.Command, cmd.Args, []shared.KV{{K: HomeEnv(kind), V: dir}}, s.platform())
}

func (s *AccountService) duplicateOf(a any) any {
	key := ""
	if k := opt(prop(a, "identity"), "key"); truthy(k) {
		key = primaryKey(k)
	}
	if key == "" || !truthy(prop(a, "loggedIn")) {
		return undef
	}
	for _, x := range s.store().accounts {
		if prop(x, "id") != prop(a, "id") && prop(x, "kind") == prop(a, "kind") && truthy(prop(x, "loggedIn")) {
			xk := opt(prop(x, "identity"), "key")
			if truthy(xk) && primaryKey(xk) == key {
				return prop(x, "label")
			}
		}
	}
	return undef
}

// List = list(kind)（kind "" = 全部）。
func (s *AccountService) List(kind string) (out []any, err error) {
	defer catchJS(&err)
	return s.list(kind), nil
}

func (s *AccountService) list(kind string) []any {
	out := []any{}
	for _, a := range s.store().accounts {
		if kind == "" || prop(a, "kind") == kind {
			out = append(out, s.view(a))
		}
	}
	return out
}

// FindByAccountID = findByAccountId（nil = undefined）。
func (s *AccountService) FindByAccountID(kind, accountID string) (v *util.Obj, err error) {
	defer catchJS(&err)
	id := util.JSTrim(accountID)
	if id == "" {
		return nil, nil
	}
	for _, x := range s.store().accounts {
		if prop(x, "kind") != kind {
			continue
		}
		ident := prop(x, "identity")
		if opt(ident, "org") == id {
			return s.view(x), nil
		}
		if nullish(ident) {
			continue
		}
		key := prop(ident, "key")
		ks, ok := key.(string)
		if !ok {
			if nullish(key) {
				panic(typeErr("Cannot read properties of " + jsStr(key) + " (reading 'split')"))
			}
			panic(typeErr("x.identity?.key.split is not a function"))
		}
		for _, p := range strings.Split(ks, "|") {
			if p == id {
				return s.view(x), nil
			}
		}
	}
	return nil, nil
}

func (s *AccountService) sessionMap() *sessionMapT {
	if s.sessions != nil {
		return s.sessions
	}
	m := &sessionMapT{m: map[string]string{}}
	if b, err := os.ReadFile(filepath.Join(s.d.Root, sessionsFile)); err == nil {
		if raw, err := parseJSON(string(b)); err == nil && !nullish(raw) {
			if arr, ok := prop(raw, "sessions").([]any); ok {
				for _, e := range arr {
					if p, ok := e.([]any); ok && len(p) >= 2 {
						k, ok1 := p[0].(string)
						v, ok2 := p[1].(string)
						if ok1 && ok2 {
							m.set(k, v)
						}
					}
				}
			}
		}
	}
	s.sessions = m
	return m
}

// NoteSession = noteSession（accountId nil = null / undefined）。
func (s *AccountService) NoteSession(kind, sessionID string, accountID *string) (err error) {
	defer catchJS(&err)
	sid := util.JSTrim(sessionID)
	if sid == "" {
		return nil
	}
	id := s.resolve(kind, accountID)
	m := s.sessionMap()
	key := kind + ":" + sid
	if v, ok := m.m[key]; ok && v == id {
		return nil
	}
	m.del(key)
	m.set(key, id)
	for len(m.keys) > maxSessions {
		m.del(m.keys[0])
	}
	pairs := make([]any, len(m.keys))
	for i, k := range m.keys {
		pairs[i] = []any{k, m.m[k]}
	}
	data := util.Stringify(util.NewObj("version", float64(1), "sessions", pairs))
	p := utils.WritePrivateFileAtomicAsync(filepath.Join(s.d.Root, sessionsFile), []byte(data))
	go func() {
		if _, err := jsrt.Block(p); err != nil {
			jsrt.Run(func() { s.warn("session-accounts write failed", errString(err)) })
		}
	}()
	return nil
}

// SessionAccount = sessionAccount（nil = undefined）。
func (s *AccountService) SessionAccount(kind, sessionID string) (v *util.Obj, err error) {
	defer catchJS(&err)
	id, ok := s.sessionMap().m[kind+":"+sessionID]
	if !ok || id == "" {
		return nil, nil
	}
	for _, a := range s.store().accounts {
		if prop(a, "id") == id && prop(a, "kind") == kind {
			return util.NewObj("id", prop(a, "id"), "label", orElse(opt(prop(a, "identity"), "email"), prop(a, "label"))), nil
		}
	}
	return nil, nil
}

// IdentityKey = identityKey（accountId nil = null / undefined；结果 nil = null）。
func (s *AccountService) IdentityKey(kind string, accountID *string) (k any, err error) {
	defer catchJS(&err)
	want := ""
	if accountID != nil {
		want = *accountID
	} else {
		want = s.defaultID(kind)
	}
	for _, a := range s.store().accounts {
		if prop(a, "id") == want {
			return orElse(opt(prop(a, "identity"), "key"), nil), nil
		}
	}
	return nil, nil
}

// Refresh = refresh(id)。
func (s *AccountService) Refresh(id string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (v *util.Obj, err error) {
		defer catchJS(&err)
		return s.refresh(id), nil
	})
}

func (s *AccountService) refresh(id string) *util.Obj {
	a := s.find(id)
	prev := prop(a, "identity")
	kind := kindOf(a)
	d := IdentityDeps{}
	if s.d.Identity != nil {
		d = *s.d.Identity
	}
	if d.Env == nil {
		d.Env = s.env()
	}
	d.Home = s.d.Home
	d.WithAccountID = kind == "codex" && !truthy(opt(prev, "accountIdChecked"))
	var dir *string
	if dv := prop(a, "dir"); !nullish(dv) {
		ds := jsStr(dv)
		dir = &ds
	}
	r := ReadIdentity(kind, dir, d)
	setProp(a, "loggedIn", r.Get("loggedIn"))
	if r.Get("loggedIn") == true {
		delProp(a, "needsLogin")
		rkey, hasKey := r.Lookup("key")
		if !hasKey {
			rkey = undef
		}
		same := truthy(prev) && truthy(rkey) && primaryKey(prop(prev, "key")) == primaryKey(rkey)
		var key any
		if truthy(rkey) && same && !truthy(r.Get("accountIdChecked")) {
			key = prop(prev, "key")
		} else {
			key = orElse(rkey, orElse(opt(prev, "key"), prop(a, "id")))
		}
		checked := truthy(r.Get("accountIdChecked")) || (same && truthy(opt(prev, "accountIdChecked")))
		ident := util.NewObj("key", key)
		for _, f := range []string{"email", "plan", "org"} {
			if v := r.Get(f); truthy(v) {
				ident.Set(f, v)
			}
		}
		if checked {
			ident.Set("accountIdChecked", true)
		}
		setProp(a, "identity", ident)
		off := t("electron.common.official-account")
		if lbl := prop(a, "label"); truthy(prop(a, "dir")) && truthy(r.Get("email")) && (lbl == off || !truthy(lbl)) {
			setProp(a, "label", r.Get("email"))
		}
	}
	s.save()
	return s.view(a)
}

// RefreshAll = refreshAll(kind)。
func (s *AccountService) RefreshAll(kind string) *jsrt.Promise[[]any] {
	return jsrt.Async(func() (v []any, err error) {
		defer catchJS(&err)
		var ids []string
		for _, a := range s.store().accounts {
			if prop(a, "kind") == kind {
				id, _ := prop(a, "id").(string)
				ids = append(ids, id)
			}
		}
		for _, id := range ids {
			if _, err := jsrt.Await(s.Refresh(id)); err != nil {
				s.warn("account identity refresh failed", errString(err))
			}
		}
		return s.list(kind), nil
	})
}

// Create = create(kind, label)（label undefined = util.Undefined）。
func (s *AccountService) Create(kind string, label any) (v *util.Obj, err error) {
	defer catchJS(&err)
	return s.create(kind, label), nil
}

func (s *AccountService) create(kind string, label any) *util.Obj {
	id := uuid.NewString()
	dir := AccountDirFor(s.d.Root, kind, id)
	problems := s.ensureHome(kind, dir)
	if len(problems) > 0 {
		s.warn("account home shared entries not linked", util.NewObj("kind", kind, "problems", problemsJSON(problems)))
	}
	off := t("electron.common.official-account")
	lbl := slice16(jsStr(orElse(label, off)), 0, 60)
	if lbl == "" {
		lbl = off
	}
	a := util.NewObj("id", id, "kind", kind, "label", lbl, "dir", dir, "identity", nil, "loggedIn", false, "createdAt", s.now())
	st := s.store()
	st.accounts = append(st.accounts, a)
	s.save()
	return s.view(a)
}

// LoginTarget = loginTarget(id)（Dir nil = null）。
type LoginTarget struct {
	Kind string
	Dir  *string
	Env  *util.Obj
}

func (s *AccountService) LoginTarget(id string) (lt LoginTarget, err error) {
	defer catchJS(&err)
	return s.loginTarget(id), nil
}

func (s *AccountService) loginTarget(id string) LoginTarget {
	a := s.find(id)
	kind := kindOf(a)
	dir := dirOf(a)
	if hasDir(dir) {
		s.ensureHome(kind, *dir)
	}
	return LoginTarget{Kind: kind, Dir: dir, Env: OfficialAccountEnv(kind, cli.WithCliPath(s.env()), dir)}
}

// SetDefault = setDefault(kind, id).
func (s *AccountService) SetDefault(kind, id string) (v *util.Obj, err error) {
	defer catchJS(&err)
	a := s.find(id)
	if prop(a, "kind") != kind {
		panic(accountErr("not-found", t("electron.common.account-not-found")))
	}
	before := s.defaultID(kind)
	s.store().setDefault(kind, id)
	setProp(a, "lastUsedAt", s.now())
	s.save()
	if before != id && s.d.OnDefaultChanged != nil {
		s.d.OnDefaultChanged(kind)
	}
	return s.view(a), nil
}

// Rename = rename(id, label).
func (s *AccountService) Rename(id string, label any) (v *util.Obj, err error) {
	defer catchJS(&err)
	a := s.find(id)
	next := slice16(util.JSTrim(jsStr(orElse(label, ""))), 0, 60)
	if next == "" {
		panic(jsrt.JSThrow{Name: "Error", Message: t("electron.common.title-cannot-be-empty")})
	}
	setProp(a, "label", next)
	s.save()
	return s.view(a), nil
}

// Remove = remove(id, { force }).
func (s *AccountService) Remove(id string, force bool) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (v struct{}, err error) {
		defer catchJS(&err)
		s.remove(id, force)
		return struct{}{}, nil
	})
}

func (s *AccountService) remove(id string, force bool) {
	a := s.find(id)
	kind := kindOf(a)
	dir := dirOf(a)
	if !hasDir(dir) {
		panic(accountErr("local", t("electron.common.this-computer-s-sign-in-is-the-cli")))
	}
	busy := s.inUse(kind, prop(a, "id"))
	if f, ok := busy.(float64); ok && f > 0 {
		panic(accountErr("in-use", t("electron.common.tab-s-still-use-this-account-close-them", jsStr(busy))))
	}
	live := LiveCheck{State: "unknown"}
	func() {
		var lerr error
		defer func() {
			if lerr != nil {
				live = LiveCheck{State: "unknown"}
			}
		}()
		defer catchJS(&lerr)
		if s.d.LiveProcesses != nil {
			l, e := s.d.LiveProcesses(kind, *dir)
			if e != nil {
				lerr = e
				return
			}
			live = l
		} else {
			live = LiveProcesses(kind, *dir, LiveDeps{Platform: s.d.Platform})
		}
	}()
	switch {
	case live.State == "busy":
		ps := make([]string, 0, 5)
		for i, p := range live.Pids {
			if i >= 5 {
				break
			}
			ps = append(ps, jsStr(p))
		}
		panic(accountErr("in-use", t("electron.common.cli-process-es-outside-nomi-still-use-this", jsStr(float64(len(live.Pids))), strings.Join(ps, ", "))))
	case live.State == "unknown" && !force:
		panic(accountErr("unknown-live", t("electron.common.could-not-confirm-whether-a-cli-is-still")))
	case live.State == "unknown":
		s.warn("account remove forced while liveProcesses unknown", util.NewObj("id", prop(a, "id"), "kind", prop(a, "kind")))
	}
	if truthy(prop(a, "loggedIn")) {
		env := OfficialAccountEnv(kind, cli.WithCliPath(s.env()), dir)
		var lerr error
		func() {
			defer catchJS(&lerr)
			if s.d.Logout != nil {
				lerr = s.d.Logout(kind, env)
			} else {
				lerr = cliLogout(kind, env)
			}
		}()
		if lerr != nil {
			s.warn("account logout failed", errString(lerr))
		}
	}
	s.removeKeychainEntry(a)
	_ = nodefs.RmForce(*dir)
	st := s.store()
	kept := []any{}
	for _, x := range st.accounts {
		if prop(x, "id") != id {
			kept = append(kept, x)
		}
	}
	st.accounts = kept
	if st.getDefault(kind) == id {
		st.deleteDefault(kind)
		s.save()
		if s.d.OnDefaultChanged != nil {
			s.d.OnDefaultChanged(kind)
		}
		return
	}
	s.save()
}

func (s *AccountService) removeKeychainEntry(a any) {
	dir := dirOf(a)
	if kindOf(a) != "claude" || !hasDir(dir) || s.platform() != "darwin" {
		return
	}
	kc := s.d.Keychain
	if kc == nil {
		kc = MacKeychain
	}
	_, _ = jsrt.Await(kc.Remove(ClaudeKeychainService(util.NewObj("CLAUDE_CONFIG_DIR", *dir), *dir), ClaudeAccountName(s.env())))
}

// PrepareLogin = prepareLogin(id).
func (s *AccountService) PrepareLogin(id string) *jsrt.Promise[struct{}] {
	return jsrt.Async(func() (v struct{}, err error) {
		defer catchJS(&err)
		s.removeKeychainEntry(s.find(id))
		return struct{}{}, nil
	})
}

// OfficialLaunch = OfficialLaunch.
type OfficialLaunch struct {
	Dir      *string
	Env      *util.Obj
	Strip    []string
	Args     []string
	Sig      string
	Problems []HomeProblem
}

// OfficialLaunch = officialLaunch(kind, accountId).
func (s *AccountService) OfficialLaunch(kind string, accountID *string) (out OfficialLaunch, err error) {
	defer catchJS(&err)
	id := ""
	if accountID != nil && *accountID != "" {
		for _, a := range s.store().accounts {
			if prop(a, "id") == *accountID {
				id = *accountID
				break
			}
		}
	}
	if id == "" {
		id = s.defaultID(kind)
	}
	a := s.find(id)
	dir := dirOf(a)
	problems := []HomeProblem{}
	if hasDir(dir) {
		problems = s.ensureHome(kind, *dir)
	}
	env := util.NewObj()
	he := HomeEnv(kind)
	if hasDir(dir) {
		env.Set(he, *dir)
		if kind == "claude" {
			env.Set("CLAUDE_CODE_DISABLE_AGENT_VIEW", "1")
		}
	}
	strip := []string{}
	for _, k := range OfficialStrip(kind) {
		if hasDir(dir) || k != he {
			strip = append(strip, k)
		}
	}
	return OfficialLaunch{Dir: dir, Env: env, Strip: strip, Args: OfficialAccountArgs(kind, dir), Sig: "official:" + jsStr(prop(a, "id")), Problems: problems}, nil
}

// Resolve = resolve(kind, accountId).
func (s *AccountService) Resolve(kind string, accountID *string) (id string, err error) {
	defer catchJS(&err)
	return s.resolve(kind, accountID), nil
}

func (s *AccountService) resolve(kind string, accountID *string) string {
	if accountID != nil && *accountID != "" {
		for _, a := range s.store().accounts {
			if prop(a, "id") == *accountID && prop(a, "kind") == kind {
				return *accountID
			}
		}
	}
	return s.defaultID(kind)
}

// BroadcastChanged = broadcastChanged.
func (s *AccountService) BroadcastChanged() {
	if s.d.Events != nil {
		s.d.Events.Publish("cliAccount.changed", nil)
	}
}

// Launch / NoteSession 适配编排层端口（ports.HarnessOfficialAccounts / AccountSessionNoter）。
type HarnessAdapter struct{ S *AccountService }

func (h HarnessAdapter) Launch(kind ports.AccountBackend, accountID *string) ports.AccountLaunch {
	l, err := h.S.OfficialLaunch(string(kind), accountID)
	if err != nil {
		panic(jsrt.JSThrow{Name: "Error", Message: err.Error()})
	}
	return ports.AccountLaunch{Env: l.Env, Strip: l.Strip, Args: l.Args, Sig: l.Sig}
}

func (h HarnessAdapter) NoteSession(kind ports.AccountBackend, sessionID string, accountID *string) {
	if err := h.S.NoteSession(string(kind), sessionID, accountID); err != nil {
		panic(jsrt.JSThrow{Name: "Error", Message: err.Error()})
	}
}

// ParseAccountKind = parseAccountKind.
func ParseAccountKind(v any) (string, error) {
	if k, ok := v.(string); ok && isKind(k) {
		return k, nil
	}
	return "", jsThrow("Error", t("electron.common.unknown-coding-agent"))
}

func cliLogout(kind string, env *util.Obj) error {
	a := LogoutArgs(kind)
	if a == nil {
		return nil
	}
	bin := cli.ResolveCliBinAsync(kind)
	if bin == "" {
		return nil
	}
	cwd, err := usage.NodeMkdtemp(filepath.Join(os.TempDir(), "nomi-acct-logout-"))
	if err != nil {
		return jsThrow("Error", err.Error())
	}
	defer os.RemoveAll(cwd)
	_, err = jsrt.Await(usage.RunLimited(bin, a, usage.RunOptions{Cwd: cwd, Env: env, TimeoutMs: logoutTimeoutMs, MaxBytes: usage.StdoutLimit}))
	return err
}

// PrecheckMessage = precheckMessage.
func PrecheckMessage(reason string) string {
	if reason == "gemini-encrypted-storage" {
		return t("electron.common.gemini-has-encrypted-credential-storage-turned-on-gemini")
	}
	return reason
}
