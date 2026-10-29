package gwstore

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CLIKinds = CLI_KINDS
var CLIKinds = []string{"claude", "codex", "dsh", "grok", "gemini"}

var nomiProtocolWire = map[string]string{"openai-chat": "chat", "openai-responses": "responses", "anthropic": "messages"}
var cliFormatWire = map[string]string{
	"anthropic_messages": "messages", "openai_chat_completions": "chat",
	"openai_responses": "responses", "gemini_generate_content": "gemini",
}

var (
	suffixRe   = regexp.MustCompile(`(?i)/(?:chat/completions|responses|messages)$`)
	trailSlash = regexp.MustCompile(`/+$`)
	v1Re       = regexp.MustCompile(`/v1$`)
	geminiVer  = regexp.MustCompile(`/v1(beta|alpha)?\d*$`)
)

// LegacyBase = legacyBase(wire, raw, fullUrl)
func LegacyBase(wire, raw string, fullURL bool) string {
	s := trailSlash.ReplaceAllString(u.JSTrim(raw), "")
	if fullURL {
		s = trailSlash.ReplaceAllString(suffixRe.ReplaceAllString(s, ""), "")
	}
	if wire == "messages" {
		return v1Re.ReplaceAllString(s, "")
	}
	if wire == "gemini" {
		if geminiVer.MatchString(s) {
			return s
		}
		return s + "/v1beta"
	}
	return s
}

func hostOf(raw string) string {
	pu, err := gwnet.ParseURL(raw)
	if err != nil || pu.Scheme == "" {
		return u.JSLower(raw)
	}
	return u.JSLower(pu.Host)
}

type entry struct {
	name      any
	presetID  string
	presetSet bool // presetId !== undefined（?? 只在 undefined 时退到 name）
	wire      string
	base      string
	keys      []string
	models    []any
	listed    []any
	modelMap  any
	headers   any
	userAgent any
	enabled   bool
	origin    string // "nomi:<id>" / "cli:<id>"
	isNomi    bool
}

func readJSON(file string) (any, bool) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, false
	}
	v, err := u.Parse(b)
	if err != nil || !u.Truthy(v) {
		return nil, false
	}
	return v, true
}

// LegacySources = LegacySources
type LegacySources struct {
	NomiFile   string
	CliRoot    string
	NomiCipher Cipher
	CliDecrypt func(enc string) string
	// NormalizeNomi 缺省 = providers.MigrateStoreData
	NormalizeNomi func(raw any) (*u.Obj, error)
}

// MigrationResult = MigrationResult
type MigrationResult struct {
	Migrated      bool
	Providers     int
	Files         []string
	Archived      []string
	Undecryptable int
}

// LegacyFileCandidates = legacyFileCandidates
func LegacyFileCandidates(src LegacySources) []string {
	out := []string{src.NomiFile}
	for _, k := range CLIKinds {
		out = append(out, filepath.Join(src.CliRoot, k, "store.json"))
	}
	return out
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// ArchiveLegacyFiles = archiveLegacyFiles
func ArchiveLegacyFiles(files []string, logger Logger) []string {
	archived := []string{}
	for _, file := range files {
		if !exists(file) {
			continue
		}
		dest := file + ".migrated"
		if exists(dest) {
			dest = fmt.Sprintf("%s.migrated-%s", file, u.FormatNumber(Now()))
		}
		if err := os.Rename(file, dest); err != nil {
			if logger != nil {
				logger.Warn("gateway: failed to archive legacy file", map[string]any{"file": file, "error": err.Error()})
			}
			continue
		}
		archived = append(archived, dest)
		if logger != nil {
			logger.Info("gateway: archived legacy provider file", map[string]any{"from": file, "to": dest})
		}
	}
	return archived
}

func asObj(v any) *u.Obj { o, _ := v.(*u.Obj); return o }

func nomiEntries(data *u.Obj, cipher Cipher, bad *int) []*entry {
	out := []*entry{}
	plist, _ := data.Get("providers").([]any)
	for _, pv := range plist {
		p := asObj(pv)
		if p == nil {
			continue
		}
		wire := "chat"
		if w, ok := nomiProtocolWire[u.JSString(p.Get("protocol"))]; ok {
			wire = w
		}
		keys := []string{}
		ks, _ := p.Get("keys").([]any)
		for _, kv := range ks {
			k := asObj(kv)
			sec, isStr := k.Get("secret").(string)
			if k == nil || !isStr {
				*bad++ // Buffer.from(undefined) / cipher 抛错
				continue
			}
			var v string
			if u.JSString(k.Get("encryption")) == cipher.Kind() {
				var err error
				if v, err = cipher.Decrypt(sec); err != nil {
					*bad++
					continue
				}
			} else {
				v = providers.NodeBase64Decode(sec)
			}
			if v != "" {
				keys = append(keys, v)
			}
		}
		models := []any{}
		add := func(m any) {
			if !u.Truthy(m) {
				return
			}
			for _, x := range models {
				if jsEq(x, m) {
					return
				}
			}
			models = append(models, m)
		}
		add(p.Get("defaultModel"))
		if ms, ok := p.Get("models").([]any); ok {
			for _, m := range ms {
				add(m)
			}
		}
		listed := []any{}
		if fm, ok := p.Get("fetchedModels").([]any); ok {
			for _, m := range fm {
				id := asObj(m).Get("id")
				in := false
				for _, x := range models {
					if jsEq(x, id) {
						in = true
					}
				}
				if !in {
					listed = append(listed, id)
				}
			}
		}
		e := &entry{
			name: p.Get("name"), wire: wire,
			base: LegacyBase(wire, u.JSString(p.Get("baseURL")), u.Truthy(p.Get("fullUrl"))),
			keys: keys, models: models, listed: listed,
			enabled: u.Truthy(p.Get("enabled")), origin: "nomi:" + u.JSString(p.Get("id")), isNomi: true,
		}
		if ps, ok := p.Get("presetId").(string); ok {
			e.presetID, e.presetSet = ps, true
		}
		if mm, ok := p.Get("modelMap").([]any); ok && len(mm) > 0 {
			e.modelMap = mm
		}
		if h := asObj(p.Get("headers")); h != nil && h.Len() > 0 {
			e.headers = h
		}
		if u.Truthy(p.Get("userAgent")) {
			e.userAgent = p.Get("userAgent")
		}
		out = append(out, e)
	}
	return out
}

type activeProfile struct {
	id    string
	model any
}

func cliEntries(cliRoot string, decrypt func(string) string, files *[]string) ([]*entry, map[string]activeProfile, error) {
	entries := []*entry{}
	active := map[string]activeProfile{}
	for _, cli := range CLIKinds {
		file := filepath.Join(cliRoot, cli, "store.json")
		j, ok := readJSON(file)
		if !ok {
			continue
		}
		*files = append(*files, file)
		profiles, _ := asObj(j).Get("profiles").([]any)
		for _, pv := range profiles {
			p := asObj(pv)
			if p == nil || !u.Truthy(p.Get("id")) || !u.Truthy(p.Get("baseUrl")) {
				continue
			}
			base, isStr := p.Get("baseUrl").(string)
			if !isStr {
				return nil, nil, fmt.Errorf("raw.trim is not a function")
			}
			wire := "chat"
			if cli == "gemini" {
				wire = "gemini"
			} else if w, ok := cliFormatWire[u.JSString(p.Get("apiFormat"))]; ok {
				wire = w
			}
			key := ""
			if u.Truthy(p.Get("keyEnc")) {
				key = decrypt(u.JSString(p.Get("keyEnc")))
			}
			var name any = p.Get("name")
			if !u.Truthy(name) {
				name = hostOf(base)
			}
			e := &entry{name: name, wire: wire, base: LegacyBase(wire, base, false), keys: []string{}, models: []any{}, listed: []any{},
				enabled: true, origin: "cli:" + u.JSString(p.Get("id"))}
			if ps, ok := p.Get("presetId").(string); ok && ps != "" && ps != "custom" {
				e.presetID, e.presetSet = ps, true
			}
			if key != "" {
				e.keys = []string{key}
			}
			if u.Truthy(p.Get("model")) {
				e.models = []any{p.Get("model")}
			}
			entries = append(entries, e)
			if u.Truthy(p.Get("active")) && u.Truthy(p.Get("model")) {
				active[cli] = activeProfile{id: u.JSString(p.Get("id")), model: p.Get("model")}
			}
		}
	}
	return entries, active, nil
}

type group struct {
	host    string
	keys    []string
	entries []*entry
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func sameProvider(a *entry, b *group) bool {
	if hostOf(a.base) != b.host {
		return false
	}
	if len(a.keys) == 0 && len(b.keys) == 0 {
		return true
	}
	for _, k := range a.keys {
		if contains(b.keys, k) {
			return true
		}
	}
	return false
}

// jsNumber：Number(v)
func jsNumber(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		return u.ToNumber(t)
	case bool:
		if t {
			return 1
		}
		return 0
	case nil:
		return math.NaN() // undefined（routing?.port 缺省）；null 也按缺省处理不影响结果
	}
	return math.NaN()
}

// MigrateLegacy = migrateLegacy(store, src, logger)
func MigrateLegacy(store *Store, src LegacySources, logger Logger) (MigrationResult, error) {
	files := []string{}
	bad := 0
	now := Now()
	normalize := src.NormalizeNomi
	if normalize == nil {
		normalize = func(raw any) (*u.Obj, error) { d, _, err := providers.MigrateStoreData(raw); return d, err }
	}
	cipher := src.NomiCipher
	if cipher == nil {
		cipher = store.cipher
	}
	var nomi *u.Obj
	if raw, ok := readJSON(src.NomiFile); ok {
		d, err := normalize(raw)
		if err != nil {
			return MigrationResult{}, err
		}
		nomi = d
		files = append(files, src.NomiFile)
	}
	all := []*entry{}
	if nomi != nil {
		all = append(all, nomiEntries(nomi, cipher, &bad)...)
	}
	decrypt := src.CliDecrypt
	if decrypt == nil {
		decrypt = LegacyCliKeyDecryptor(store.cipher)
	}
	fromCli, active, err := cliEntries(src.CliRoot, decrypt, &files)
	if err != nil {
		return MigrationResult{}, err
	}
	all = append(all, fromCli...)

	groups := []*group{}
	for _, e := range all {
		var g *group
		for _, x := range groups {
			if sameProvider(e, x) {
				g = x
				break
			}
		}
		if g != nil {
			g.entries = append(g.entries, e)
			for _, k := range e.keys {
				if !contains(g.keys, k) {
					g.keys = append(g.keys, k)
				}
			}
		} else {
			groups = append(groups, &group{host: hostOf(e.base), keys: append([]string{}, e.keys...), entries: []*entry{e}})
		}
	}

	idOf := map[string]string{}
	for _, g := range groups {
		first := g.entries[0]
		for _, e := range g.entries {
			if e.isNomi {
				first = e
				break
			}
		}
		base := first.presetID
		if !first.presetSet {
			base = u.JSString(first.name)
		}
		id := store.UniqueProviderID(base)
		urls := u.NewObj()
		for _, e := range g.entries {
			if !urls.Has(e.wire) {
				urls.Set(e.wire, e.base)
			}
		}
		models := []*u.Obj{}
		addModel := func(mid any, enabled bool) {
			for _, m := range models {
				if jsEq(m.Get("id"), mid) {
					if !u.Truthy(m.Get("enabled")) && enabled {
						m.Set("enabled", true)
					}
					return
				}
			}
			models = append(models, u.NewObj("id", mid, "enabled", enabled))
		}
		for _, e := range g.entries {
			for _, m := range e.models {
				addModel(m, true)
			}
			for _, m := range e.listed {
				addModel(m, false)
			}
		}
		p := u.NewObj("id", id)
		if first.name != nil {
			p.Set("name", first.name)
		}
		if first.presetID != "" {
			p.Set("presetId", first.presetID)
		}
		enabled := false
		for _, e := range g.entries {
			enabled = enabled || e.enabled
		}
		keys := []any{}
		for _, k := range g.keys {
			keys = append(keys, store.MakeKey(k, KeyOpts{}))
		}
		ms := make([]any, len(models))
		for i, m := range models {
			ms[i] = m
		}
		p.Set("enabled", enabled).Set("urls", urls).Set("keys", keys).Set("models", ms).Set("modelsSource", "manual")
		for _, e := range g.entries {
			if e.modelMap != nil {
				p.Set("modelMap", e.modelMap)
				break
			}
		}
		for _, e := range g.entries {
			if e.headers != nil {
				p.Set("headers", e.headers)
				break
			}
		}
		for _, e := range g.entries {
			if e.userAgent != nil {
				p.Set("userAgent", e.userAgent)
				break
			}
		}
		p.Set("source", "user").Set("createdAt", now).Set("updatedAt", now)
		store.UpsertProvider(p)
		for _, e := range g.entries {
			idOf[e.origin] = id
		}
	}

	store.EnsureClients()
	if nomi != nil {
		plist, _ := nomi.Get("providers").([]any)
		routes := asObj(nomi.Get("routes"))
		ref := func(providerID, model any) (string, bool) {
			if !u.Truthy(providerID) {
				return "", false
			}
			var p *u.Obj
			for _, x := range plist {
				if o := asObj(x); o != nil && jsEq(o.Get("id"), providerID) {
					p = o
					break
				}
			}
			id, ok := idOf["nomi:"+u.JSString(providerID)]
			m := model
			if !u.Truthy(m) && p != nil {
				m = p.Get("defaultModel")
			}
			if !ok || id == "" || !u.Truthy(m) {
				return "", false
			}
			return id + "/" + u.JSString(m), true
		}
		route := func(name string) (any, any) {
			r := asObj(routes.Get(name))
			if r == nil {
				return nil, nil
			}
			return r.Get("providerId"), r.Get("model")
		}
		models := u.NewObj()
		if v, ok := ref(nomi.Get("activeProviderId"), nil); ok {
			models.Set("main", v)
		}
		if v, ok := ref(route("agent-tools")); ok {
			models.Set("tools", v)
		}
		if v, ok := ref(route("summary")); ok {
			models.Set("summary", v)
		}
		_ = store.SetClient("nomi", ClientPatch{Models: models})
	}
	for _, cli := range CLIKinds {
		a, ok := active[cli]
		if !ok {
			continue
		}
		if id, ok := idOf["cli:"+a.id]; ok && id != "" {
			_ = store.SetClient(cli, ClientPatch{Models: u.NewObj("main", id+"/"+u.JSString(a.model)), NewTabSource: "thirdParty"})
		}
	}

	data := store.Snapshot()
	if routing, ok := readJSON(filepath.Join(src.CliRoot, "routing.json")); ok {
		var pv any
		if o := asObj(routing); o != nil {
			pv = o.Get("port")
		}
		port := jsNumber(pv)
		if port == math.Trunc(port) && !math.IsInf(port, 0) && port > 0 && port < 65536 && port != DefaultGatewayPort {
			data.Set("port", port)
		}
	}
	allowed, _ := data.Get("allowedPrivateHosts").([]any)
	plist, _ := data.Get("providers").([]any)
	for _, pv := range plist {
		urls := asObj(asObj(pv).Get("urls"))
		if urls == nil {
			continue
		}
		for _, k := range urls.Keys() {
			raw, ok := urls.Get(k).(string)
			if !ok {
				continue
			}
			pu, err := gwnet.ParseURL(raw)
			if err != nil || pu.Scheme == "" || pu.Host == "" {
				continue
			}
			hostname := pu.Hostname()
			if !gwnet.IsPrivateHost(hostname) {
				continue
			}
			port := pu.Port()
			if port == "" {
				if pu.Scheme == "https" {
					port = "443"
				} else {
					port = "80"
				}
			}
			hp := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(hostname, "["), "]")) + ":" + port
			dup := false
			for _, a := range allowed {
				if a == hp {
					dup = true
				}
			}
			if !dup {
				allowed = append(allowed, hp)
			}
		}
	}
	data.Set("allowedPrivateHosts", allowed)
	fl := make([]any, len(files))
	for i, f := range files {
		fl[i] = f
	}
	data.Set("migratedFrom", u.NewObj("at", now, "files", fl))
	store.Replace(data)
	if err := store.Save(); err != nil {
		return MigrationResult{}, err
	}
	left := []string{}
	for _, f := range LegacyFileCandidates(src) {
		if exists(f) {
			left = append(left, f)
		}
	}
	archived := ArchiveLegacyFiles(left, logger)
	if logger != nil {
		logger.Info("gateway: migrated legacy providers", map[string]any{
			"providers": len(groups), "files": len(files), "archived": len(archived), "undecryptable": bad,
		})
	}
	return MigrationResult{Migrated: true, Providers: len(groups), Files: files, Archived: archived, Undecryptable: bad}, nil
}
