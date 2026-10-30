package gwstore

// service_write.go = GatewayService 的界面视图与修改：state / envViews / upsertProvider / removeProvider /
// setAssignment / resetToken / setOptions / 隐私模式 / clearLearned / learn / keyStatus /
// confirmPrivateHost / retry / applyModelsData / setLegacyRevoke。

import (
	"errors"
	"math"
	"os"
	"regexp"
	"sort"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/privacy"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	minSyncedModels = 100
	previewMax      = 20_000
)

var (
	wireLabel   = map[string]string{"messages": "Anthropic", "responses": "Responses", "chat": "Chat", "gemini": "Gemini"}
	efforts     = []string{"minimal", "low", "medium", "high", "xhigh", "max"}
	hostPortRe  = regexp.MustCompile(`^[a-z0-9.:\[\]-]+:\d{1,5}$`)
	allowTagRe  = regexp.MustCompile(`^[a-z2-7]{8}$`)
	errReadOnly = func() error {
		return errors.New(i18n.T("electron.common.providers-from-environment-variables-are-read-only"))
	}
)

func trErr(key string, args ...any) error { return errors.New(i18n.T(key, args...)) }

// lock：Node 单线程；Go 的修改串行，changed() 在锁外发（监听器可能回读 state）。
// unlock 前先发布快照（#195）：锁外读者经 Store.View() 只看到已提交的完整版本
func (s *Service) lock() { s.rt.mu.Lock() }
func (s *Service) unlock() {
	s.Store.Publish()
	s.rt.mu.Unlock()
}

// commitLocked：持锁落盘 + 推配置；返回解锁后要做的 changed
func (s *Service) commitUnlock() error {
	err := s.Store.Save()
	s.push()
	s.unlock()
	s.changed()
	return err
}

func isJSInt(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && f == math.Trunc(f)
}

// withLimits = withLimits(key, input)
func withLimits(key, input *u.Obj) *u.Obj {
	out := key.Clone()
	for _, f := range []string{"maxConcurrency", "rpm"} {
		if !input.Has(f) {
			continue
		}
		if v, ok := isJSInt(input.Get(f)); ok && v > 0 && v <= 100_000 {
			out.Set(f, v)
		} else {
			out.Delete(f)
		}
	}
	return out
}

func objKeysLen(v any) int {
	if o := asObj(v); o != nil {
		return len(o.Keys())
	}
	return 0
}

func hasLearned(l any) bool {
	o := asObj(l)
	if o == nil {
		return false
	}
	if objKeysLen(o.Get("wireDown")) > 0 || objKeysLen(o.Get("modelWire")) > 0 || objKeysLen(o.Get("droppedParams")) > 0 || objKeysLen(o.Get("models")) > 0 {
		return true
	}
	a, _ := o.Get("customToolsRefused").([]any)
	return len(a) > 0
}

func (s *Service) withEffective(m *u.Obj, r ResolvedModelMeta) *u.Obj {
	eff := u.NewObj("ctx", r.Ctx, "maxOutput", r.MaxOutput)
	if r.Reasoning != nil {
		eff.Set("reasoning", *r.Reasoning)
	}
	if r.Vision != nil {
		eff.Set("vision", *r.Vision)
	}
	eff.Set("source", r.Source).Set("maxOutputSource", r.MaxOutputSource)
	if r.LongContext != nil {
		lc := u.NewObj("standard", r.LongContext.Standard, "full", r.LongContext.Full, "on", r.LongContext.On)
		if s.rt.d.LongContextPrice != nil {
			id, _ := m.Get("id").(string)
			if price := s.rt.d.LongContextPrice(id); price != nil {
				lc.Set("price", price)
			}
		}
		eff.Set("longContext", lc)
	}
	out := m.Clone()
	out.Set("effective", eff)
	return out
}

func idOf(v any) string {
	if o := asObj(v); o != nil {
		s, _ := o.Get("id").(string)
		return s
	}
	return ""
}

func (s *Service) findProvider(id string) *u.Obj {
	for _, raw := range s.Store.Providers() {
		if p := asObj(raw); p != nil && p.Get("id") == id {
			return p
		}
	}
	return nil
}

// State = state()
func (s *Service) State() *u.Obj {
	s.rt.mu.Lock() // 只读：不用重新发布
	defer s.rt.mu.Unlock()
	return s.state()
}

func (s *Service) state() *u.Obj {
	data := s.Store.Snapshot()
	learned := asObj(data.Get("learned"))
	provs := []any{}
	for _, raw := range arr(data.Get("providers")) {
		p := asObj(raw)
		v := p.Clone()
		ms := []any{}
		for _, mr := range arr(p.Get("models")) {
			m := asObj(mr)
			ms = append(ms, s.withEffective(m, s.Store.ModelMeta(p, idOf(m), nil)))
		}
		v.Set("models", ms)
		ks := []any{}
		for _, kr := range arr(p.Get("keys")) {
			k := asObj(kr).Clone()
			enc, encryption := k.Get("enc"), k.Get("encryption")
			k.Delete("enc")
			k.Delete("encryption")
			_, ok := s.Store.Decrypt(enc, encryption)
			k.Set("decryptable", ok)
			ks = append(ks, k)
		}
		v.Set("keys", ks)
		if learned != nil {
			if l := learned.Get(idOf(p)); hasLearned(l) {
				v.Set("learned", l)
			}
		}
		provs = append(provs, v)
	}
	for _, p := range s.envViews() {
		ms := []any{}
		for _, mr := range arr(p.Get("models")) {
			m := asObj(mr)
			pid, _ := p.Get("id").(string)
			meta := s.Store.ModelMeta(u.NewObj("presetId", sliceFrom(pid, 4), "models", []any{m}), idOf(m), nil)
			ms = append(ms, s.withEffective(m, meta))
		}
		p.Set("models", ms)
		provs = append(provs, p)
	}
	clients := u.NewObj()
	cs := asObj(data.Get("clients"))
	for _, id := range config.ClientIDs {
		if cs == nil {
			break
		}
		c := asObj(cs.Get(id))
		if c == nil {
			continue
		}
		v := u.NewObj("models", c.Get("models"))
		if u.Truthy(c.Get("newTabSource")) {
			v.Set("newTabSource", c.Get("newTabSource"))
		}
		if u.Truthy(c.Get("newTabAccountId")) {
			v.Set("newTabAccountId", c.Get("newTabAccountId"))
		}
		clients.Set(id, v)
	}
	var mrb *float64
	if f, ok := data.Get("maxRequestBodyBytes").(float64); ok {
		mrb = &f
	} else {
		d := float64(32 * 1024 * 1024)
		mrb = &d
	}
	actions := u.NewObj()
	if a := asObj(data.Get("privacyActions")); a != nil {
		actions = a.Clone()
	}
	secrets := []any{}
	for _, sr := range arr(data.Get("privacySecrets")) {
		x := asObj(sr)
		secrets = append(secrets, u.NewObj("id", x.Get("id"), "name", x.Get("name"), "masked", x.Get("masked")))
	}
	allow := []any{}
	for _, ar := range arr(data.Get("privacyAllow")) {
		allow = append(allow, asObj(ar).Clone())
	}
	out := u.NewObj(
		"status", s.rt.proc.GetStatus().Obj(),
		"providers", provs,
		"clients", clients,
		"allowedPrivateHosts", data.Get("allowedPrivateHosts"),
		"port", data.Get("port"),
		"strictParams", data.Get("strictParams") == true,
		"maxRequestBodyBytes", float64(config.ClampMaxRequestBodyBytes(mrb)),
		"privacyMode", data.Get("privacyMode") != false,
		"privacy", u.NewObj(
			"strict", data.Get("privacyStrict") == true,
			"local", data.Get("privacyLocal") == true,
			"shape", data.Get("privacyShape") == true,
			"actions", actions,
			"secrets", secrets,
			"allow", allow,
		),
	)
	if u.Truthy(data.Get("migratedFrom")) {
		out.Set("migratedFrom", data.Get("migratedFrom"))
	}
	if rn := arr(data.Get("recentNomi")); len(rn) > 0 {
		out.Set("recentNomi", rn)
	}
	ver := models.CatalogVersion
	if o := models.CatalogOverlayVersion(); o != nil {
		ver = *o
	}
	out.Set("catalog", u.NewObj("models", float64(models.CatalogSize()), "version", ver, "synced", s.HasCatalogSync()))
	if s.rt.legacyRevoke != nil {
		out.Set("legacyRevoke", s.rt.legacyRevoke)
	}
	return out
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

// envViews = envViews()
func (s *Service) envViews() []*u.Obj {
	out := []*u.Obj{}
	for _, e := range s.envList() {
		keys := []any{}
		if e.Key != "" {
			keys = append(keys, u.NewObj("id", "env", "name", e.KeyEnv, "masked", MaskKey(e.Key), "enabled", true, "decryptable", true))
		}
		ms := []any{}
		if e.Model != "" {
			ms = append(ms, u.NewObj("id", e.Model, "enabled", true))
		}
		out = append(out, u.NewObj(
			"id", "env-"+e.ID, "name", e.Name, "enabled", true,
			"urls", u.NewObj(e.Wire, e.URL), "keys", keys, "models", ms,
			"modelsSource", "manual", "source", "env", "createdAt", 0.0, "updatedAt", 0.0,
		))
	}
	return out
}

func (s *Service) bumpLearn(id string) { s.rt.learnGen[id]++ }

func strOf(v any) (string, bool) {
	x, ok := v.(string)
	return x, ok
}

// UpsertProvider = upsertProvider(input)
func (s *Service) UpsertProvider(input *u.Obj) (*u.Obj, error) {
	nameRaw, _ := strOf(input.Get("name"))
	name := u.JSTrim(nameRaw)
	if name == "" {
		return nil, trErr("electron.common.name-can-t-be-empty")
	}
	s.lock()
	now := Now()
	inID, _ := strOf(input.Get("id"))
	var prev *u.Obj
	if inID != "" {
		prev = s.findProvider(inID)
		if prev == nil {
			s.unlock()
			return nil, trErr("electron.common.provider-not-found")
		}
	}
	if prev != nil && prev.Get("source") == "env" {
		s.unlock()
		return nil, errReadOnly()
	}
	existing := map[string]*u.Obj{}
	var prevKeys []any
	if prev != nil {
		prevKeys = arr(prev.Get("keys"))
		// new Map：同 id 后者覆盖
		for _, kr := range prevKeys {
			if k := asObj(kr); k != nil {
				existing[idOf(k)] = k
			}
		}
	}
	keys := []any{}
	if ik, ok := input.Get("keys").([]any); ok {
		for _, kr := range ik {
			k := asObj(kr)
			if k == nil {
				continue
			}
			old := existing[idOf(k)]
			if old == nil {
				continue
			}
			n := old.Clone()
			n.Set("enabled", k.Get("enabled"))
			if k.Has("name") && k.Get("name") != u.Undefined {
				n.Set("name", k.Get("name"))
			}
			if k.Has("wire") {
				n.Set("wire", k.Get("wire"))
			} else {
				n.Set("wire", u.Undefined)
			}
			keys = append(keys, withLimits(n, k))
		}
	} else {
		keys = append(keys, prevKeys...)
	}
	type added struct {
		key *u.Obj
		pos any
	}
	var adds []added
	type nk struct {
		k   *u.Obj
		val string
	}
	var nks []nk
	for _, kr := range arr(input.Get("newKeys")) {
		k := asObj(kr)
		if k == nil {
			continue
		}
		raw, _ := strOf(k.Get("value"))
		v := u.JSTrim(raw)
		if v == "" {
			continue
		}
		c := k.Clone()
		c.Set("value", v)
		nks = append(nks, nk{c, v})
	}
	posOf := func(k *u.Obj) float64 {
		if f, ok := k.Get("position").(float64); ok {
			return f
		}
		return math.Inf(1)
	}
	sort.SliceStable(nks, func(i, j int) bool { return posOf(nks[i].k)-posOf(nks[j].k) < 0 })
	for _, x := range nks {
		kn, _ := strOf(x.k.Get("name"))
		kw, _ := strOf(x.k.Get("wire"))
		key := s.Store.MakeKey(x.val, KeyOpts{Name: kn, Wire: kw})
		if en, ok := x.k.Get("enabled").(bool); ok {
			key.Set("enabled", en)
		} else {
			key.Set("enabled", true)
		}
		adds = append(adds, added{withLimits(key, x.k), x.k.Get("position")})
	}
	for _, a := range adds {
		at := len(keys)
		if p, ok := isJSInt(a.pos); ok {
			at = int(math.Max(0, math.Min(p, float64(len(keys)))))
		}
		keys = append(keys[:at], append([]any{a.key}, keys[at:]...)...)
	}
	var p *u.Obj
	if prev != nil {
		p = deepClone(prev).(*u.Obj)
	} else {
		p = u.NewObj("createdAt", now, "source", "user", "modelsSource", "manual")
	}
	id := ""
	if prev != nil {
		id = idOf(prev)
	} else {
		base := name
		if pr, ok := strOf(input.Get("presetId")); ok {
			base = pr
		}
		id = s.Store.UniqueProviderID(base)
	}
	p.Set("id", id).Set("name", name)
	if u.Truthy(input.Get("presetId")) {
		p.Set("presetId", input.Get("presetId"))
	}
	enabled := any(true)
	if v := input.Get("enabled"); v != nil && v != u.Undefined {
		enabled = v
	} else if prev != nil {
		if v := prev.Get("enabled"); v != nil && v != u.Undefined {
			enabled = v
		}
	}
	p.Set("enabled", enabled)
	merged := u.NewObj()
	if prev != nil {
		if o := asObj(prev.Get("urls")); o != nil {
			for _, k := range o.Keys() {
				merged.Set(k, o.Get(k))
			}
		}
	}
	if o := asObj(input.Get("urls")); o != nil {
		for _, k := range o.Keys() {
			merged.Set(k, o.Get(k))
		}
	}
	urls := u.NewObj()
	for _, k := range merged.Keys() {
		if v, ok := strOf(merged.Get(k)); ok && u.JSTrim(v) != "" {
			urls.Set(k, u.JSTrim(v))
		}
	}
	p.Set("urls", urls)
	p.Set("keys", keys)
	if im, ok := input.Get("models").([]any); ok {
		ms := make([]any, 0, len(im))
		for _, mr := range im {
			if m := asObj(mr); m != nil {
				c := m.Clone()
				c.Delete("effective")
				ms = append(ms, c)
			} else {
				ms = append(ms, mr)
			}
		}
		p.Set("models", ms)
	} else if prev != nil && prev.Has("models") && prev.Get("models") != nil {
		p.Set("models", prev.Get("models"))
	} else {
		p.Set("models", []any{})
	}
	for _, f := range []string{"modelMap", "headers"} {
		if u.Truthy(input.Get(f)) {
			p.Set(f, input.Get(f))
		}
	}
	if input.Has("userAgent") && input.Get("userAgent") != u.Undefined {
		if u.Truthy(input.Get("userAgent")) {
			p.Set("userAgent", input.Get("userAgent"))
		} else {
			p.Set("userAgent", u.Undefined)
		}
	}
	for _, f := range []string{"fallback", "detected", "quirks"} {
		if u.Truthy(input.Get(f)) {
			p.Set(f, input.Get(f))
		}
	}
	if prev != nil && prev.Has("createdAt") && prev.Get("createdAt") != nil && prev.Get("createdAt") != u.Undefined {
		p.Set("createdAt", prev.Get("createdAt"))
	} else {
		p.Set("createdAt", now)
	}
	p.Set("updatedAt", now)
	s.bumpLearn(id)
	s.Store.UpsertProvider(p)
	err := s.Store.Save()
	s.push()
	view := s.state()
	s.unlock()
	s.changed()
	if err != nil {
		return nil, err
	}
	for _, v := range arr(view.Get("providers")) {
		if idOf(v) == id {
			return asObj(v), nil
		}
	}
	return nil, nil
}

// RemoveProvider = removeProvider(id)
func (s *Service) RemoveProvider(id string) error {
	s.lock()
	p := s.findProvider(id)
	if p == nil {
		s.unlock()
		return nil
	}
	if p.Get("source") == "env" {
		s.unlock()
		return errReadOnly()
	}
	s.bumpLearn(id)
	s.Store.RemoveProvider(id)
	return s.commitUnlock()
}

func knownClient(client any) (string, error) {
	c, _ := client.(string)
	for _, id := range config.ClientIDs {
		if id == c {
			return c, nil
		}
	}
	return "", trErr("electron.common.unknown-client")
}

// SetAssignmentFor = setAssignmentFor(client, patch)
func (s *Service) SetAssignmentFor(client any, patch *u.Obj) error {
	c, err := knownClient(client)
	if err != nil {
		return err
	}
	if patch == nil {
		patch = u.NewObj()
	}
	return s.SetAssignment(c, patch)
}

// normalizeAssignmentPatch：同 Node（undefined 用 nil 表示）
func normalizeAssignmentPatch(client string, patch *u.Obj) *u.Obj {
	if client == "nomi" {
		return patch
	}
	m := asObj(patch.Get("models"))
	hasMain := m != nil && m.Has("main")
	withMainCleared := func() *u.Obj {
		nm := u.NewObj()
		if m != nil {
			nm = m.Clone()
		}
		nm.Set("main", nil)
		return nm
	}
	if hasMain {
		out := patch.Clone()
		if u.Truthy(m.Get("main")) {
			out.Set("newTabSource", "thirdParty").Set("newTabAccountId", nil)
			return out
		}
		out.Set("newTabSource", "official").Set("models", withMainCleared())
		return out
	}
	if patch.Get("newTabSource") == "official" {
		out := patch.Clone()
		out.Set("models", withMainCleared())
		return out
	}
	return patch
}

// SetAssignment = setAssignment(client, patch)
func (s *Service) SetAssignment(client string, patch *u.Obj) error {
	n := normalizeAssignmentPatch(client, patch)
	cp := ClientPatch{}
	if m := asObj(n.Get("models")); m != nil {
		cp.Models = m
	}
	if t, ok := strOf(n.Get("newTabSource")); ok {
		cp.NewTabSource = t
	}
	if n.Has("newTabAccountId") && n.Get("newTabAccountId") != u.Undefined {
		cp.AccountSet = true
		cp.AccountID, _ = strOf(n.Get("newTabAccountId"))
	}
	s.lock()
	if err := s.Store.SetClient(client, cp); err != nil {
		s.unlock()
		return err
	}
	if client == "nomi" && cp.Models != nil {
		if main, ok := strOf(cp.Models.Get("main")); ok && main != "" {
			data := s.Store.Snapshot()
			rn := []any{main}
			for _, r := range arr(data.Get("recentNomi")) {
				if r != main {
					rn = append(rn, r)
				}
			}
			if len(rn) > 5 {
				rn = rn[:5]
			}
			data.Set("recentNomi", rn)
			s.Store.Replace(data)
		}
	}
	return s.commitUnlock()
}

// ResetTokenFor = resetTokenFor(client)
func (s *Service) ResetTokenFor(client any) error {
	c, err := knownClient(client)
	if err != nil {
		return err
	}
	return s.ResetToken(c)
}

// ResetToken = resetToken(client)
func (s *Service) ResetToken(client string) error {
	s.lock()
	s.Store.ResetToken(client)
	return s.commitUnlock()
}

// SetOptions = setOptions(patch)
func (s *Service) SetOptions(patch *u.Obj) (*u.Obj, error) {
	s.lock()
	changed := false
	data := s.Store.Snapshot()
	if b, ok := patch.Get("strictParams").(bool); ok {
		if b {
			data.Set("strictParams", true)
		} else {
			data.Delete("strictParams")
		}
		changed = true
	}
	if f, ok := patch.Get("maxRequestBodyBytes").(float64); ok {
		data.Set("maxRequestBodyBytes", float64(config.ClampMaxRequestBodyBytes(&f)))
		changed = true
	}
	if b, ok := patch.Get("privacyMode").(bool); ok {
		if b {
			data.Delete("privacyMode")
		} else {
			data.Set("privacyMode", false)
		}
		changed = true
	}
	for _, k := range []string{"privacyStrict", "privacyLocal", "privacyShape"} {
		b, ok := patch.Get(k).(bool)
		if !ok {
			continue
		}
		if b {
			data.Set(k, true)
		} else {
			data.Delete(k)
		}
		changed = true
	}
	if !changed {
		st := s.state()
		s.unlock()
		return st, nil
	}
	s.Store.Replace(data)
	return s.commitState()
}

// commitState：落盘、推配置、取 state，再在锁外通知
func (s *Service) commitState() (*u.Obj, error) {
	err := s.Store.Save()
	s.push()
	st := s.state()
	s.unlock()
	s.changed()
	if err != nil {
		return nil, err
	}
	return st, nil
}

/* ------------------------------ 隐私模式 ------------------------------ */

// PreviewPrivacy = previewPrivacy(text)：{ text, hits }
func (s *Service) PreviewPrivacy(text any) *u.Obj {
	str := ""
	if t, ok := text.(string); ok {
		str = u.UTF16Slice0(t, previewMax)
	}
	cfg := s.gatewayConfig(s.Store.View())
	pc := config.PrivacyConfig{}
	if cfg.Privacy != nil {
		pc = *cfg.Privacy
	}
	pc.Known = nil
	for _, e := range privacy.KnownSecrets(cfg) {
		pc.Known = append(pc.Known, config.KnownSecret{Kind: e.Kind, Value: e.Value})
	}
	out, hits := privacy.PreviewPrivacy(str, &pc)
	hs := make([]any, len(hits))
	for i, h := range hits {
		hs[i] = h.Obj()
	}
	return u.NewObj("text", out, "hits", hs)
}

// NotePrivacy = notePrivacy(e)
func (s *Service) NotePrivacy(e *u.Obj) {
	if s.rt.privacyLog != nil {
		s.rt.privacyLog.Note(e)
	}
}

// PrivacyLogEntries = privacyLogEntries()
func (s *Service) PrivacyLogEntries() []any { return s.rt.privacyLog.List() }

// ClearPrivacyLog = clearPrivacyLog()
func (s *Service) ClearPrivacyLog() { s.rt.privacyLog.Clear() }

// SetPrivacyAction = setPrivacyAction(kind, action)
func (s *Service) SetPrivacyAction(kind, action any) (*u.Obj, error) {
	k, _ := kind.(string)
	known := false
	for _, x := range privacy.PrivacyKinds {
		if x == k {
			known = true
		}
	}
	if _, ok := kind.(string); !ok || !known {
		return nil, trErr("electron.common.privacy-unknown-secret-kind")
	}
	if action != "mask" && action != "warn" && action != "block" {
		return nil, trErr("electron.common.privacy-unknown-secret-action")
	}
	s.lock()
	data := s.Store.Snapshot()
	actions := u.NewObj()
	if a := asObj(data.Get("privacyActions")); a != nil {
		actions = a.Clone()
	}
	if action == "mask" {
		actions.Delete(k)
	} else {
		actions.Set(k, action)
	}
	if len(actions.Keys()) > 0 {
		data.Set("privacyActions", actions)
	} else {
		data.Delete("privacyActions")
	}
	s.Store.Replace(data)
	return s.commitState()
}

// AddPrivacySecret = addPrivacySecret(input)
func (s *Service) AddPrivacySecret(input any) (*u.Obj, error) {
	o := asObj(input)
	if o == nil {
		o = u.NewObj()
	}
	name, value := "", ""
	if n, ok := strOf(o.Get("name")); ok {
		name = u.UTF16Slice0(u.JSTrim(n), 40)
	}
	if v, ok := strOf(o.Get("value")); ok {
		value = u.JSTrim(v)
	}
	if name == "" {
		return nil, trErr("electron.common.name-can-t-be-empty")
	}
	if l := u.UTF16Len(value); l < privacy.MinKnown || l > 4096 {
		return nil, trErr("electron.common.privacy-secret-length-invalid", privacy.MinKnown)
	}
	s.lock()
	data := s.Store.Snapshot()
	list := arr(data.Get("privacySecrets"))
	if len(list) >= 100 {
		s.unlock()
		return nil, trErr("electron.common.privacy-too-many-secrets")
	}
	for _, x := range list {
		sx := asObj(x)
		if v, ok := s.Store.Decrypt(sx.Get("enc"), sx.Get("encryption")); ok && v == value {
			s.unlock()
			return nil, trErr("electron.common.privacy-secret-already-added")
		}
	}
	enc, encryption := s.Store.Encrypt(value)
	next := append(append([]any{}, list...), u.NewObj(
		"id", "s-"+RandomUUID()[:8], "name", name, "enc", enc, "encryption", encryption, "masked", MaskKey(value)))
	data.Set("privacySecrets", next)
	s.Store.Replace(data)
	return s.commitState()
}

func (s *Service) removeFromList(field, key string, val any) (*u.Obj, error) {
	s.lock()
	data := s.Store.Snapshot()
	list := arr(data.Get(field))
	next := []any{}
	for _, x := range list {
		if asObj(x).Get(key) != val {
			next = append(next, x)
		}
	}
	if len(next) == len(list) {
		st := s.state()
		s.unlock()
		return st, nil
	}
	if len(next) > 0 {
		data.Set(field, next)
	} else {
		data.Delete(field)
	}
	s.Store.Replace(data)
	return s.commitState()
}

// RemovePrivacySecret = removePrivacySecret(id)
func (s *Service) RemovePrivacySecret(id any) (*u.Obj, error) {
	return s.removeFromList("privacySecrets", "id", id)
}

// RemovePrivacyAllow = removePrivacyAllow(tag)
func (s *Service) RemovePrivacyAllow(tag any) (*u.Obj, error) {
	return s.removeFromList("privacyAllow", "tag", tag)
}

// AddPrivacyAllow = addPrivacyAllow(input)
func (s *Service) AddPrivacyAllow(input any) (*u.Obj, error) {
	o := asObj(input)
	if o == nil {
		o = u.NewObj()
	}
	var entry *u.Obj
	if v, ok := strOf(o.Get("value")); ok && u.JSTrim(v) != "" {
		v = u.UTF16Slice0(u.JSTrim(v), 256)
		n := u.UTF16Len(v)
		entry = u.NewObj("tag", privacy.AllowTagOf(s.Store.View().PrivacyKey(), v), "kind", "CUSTOM", "len", float64(n),
			"head", u.UTF16Slice0(v, int(math.Min(4, math.Floor(float64(n)/4)))))
	} else if t, ok := strOf(o.Get("tag")); ok && allowTagRe.MatchString(t) {
		kind := "CUSTOM"
		if k, ok := strOf(o.Get("kind")); ok {
			kind = u.UTF16Slice0(k, 32)
		}
		l := 0.0
		if f, ok := o.Get("len").(float64); ok && f >= 0 {
			l = math.Trunc(f)
		}
		head := ""
		if h, ok := strOf(o.Get("head")); ok {
			head = u.UTF16Slice0(h, 4)
		}
		entry = u.NewObj("tag", t, "kind", kind, "len", l, "head", head)
	} else {
		return nil, trErr("electron.common.privacy-allow-entry-invalid")
	}
	s.lock()
	data := s.Store.Snapshot()
	list := arr(data.Get("privacyAllow"))
	for _, a := range list {
		if asObj(a).Get("tag") == entry.Get("tag") {
			st := s.state()
			s.unlock()
			return st, nil
		}
	}
	if len(list) >= 200 {
		s.unlock()
		return nil, trErr("electron.common.privacy-too-many-allow-entries")
	}
	entry.Set("at", Now())
	data.Set("privacyAllow", append(append([]any{}, list...), entry))
	s.Store.Replace(data)
	return s.commitState()
}

/* ------------------------------ 学习 / Key 状态 / 私网地址 ------------------------------ */

// ClearLearned = clearLearned(providerId)
func (s *Service) ClearLearned(providerID string) error {
	s.lock()
	s.bumpLearn(providerID)
	s.Store.SetLearned(providerID, u.NewObj())
	return s.commitUnlock()
}

func (s *Service) learnedOf(id string) *u.Obj {
	if l := asObj(s.Store.Snapshot().Get("learned")); l != nil {
		if c := asObj(l.Get(id)); c != nil {
			return c
		}
	}
	return u.NewObj()
}

func containsAny(a []any, v any) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}

// Learn = learn(e)
func (s *Service) Learn(e server.LearnEvent) {
	s.lock()
	p := s.findProvider(e.ProviderID)
	if p == nil {
		s.unlock()
		return
	}
	pid := idOf(p)
	cur := s.learnedOf(pid)
	switch e.Type {
	case "dropped-param":
		dp := asObj(cur.Get("droppedParams"))
		list := []any{}
		if dp != nil {
			if l, ok := dp.Get(e.Wire).([]any); ok {
				list = l
			}
		}
		if containsAny(list, e.Param) {
			s.unlock()
			return
		}
		n := u.NewObj()
		if dp != nil {
			n = dp.Clone()
		}
		n.Set(e.Wire, append(append([]any{}, list...), e.Param))
		cur.Set("droppedParams", n)
	case "model-wire":
		all := []any{}
		urls := asObj(p.Get("urls"))
		if urls != nil {
			for _, w := range urls.Keys() {
				if u.Truthy(urls.Get(w)) {
					all = append(all, w)
				}
			}
		}
		mw := asObj(cur.Get("modelWire"))
		base := all
		if mw != nil {
			if l, ok := mw.Get(e.Model).([]any); ok {
				base = l
			}
		}
		allowed := []any{}
		for _, w := range base {
			if w != e.Exclude {
				allowed = append(allowed, w)
			}
		}
		if len(allowed) == 0 {
			s.unlock()
			return
		}
		n := u.NewObj()
		if mw != nil {
			n = mw.Clone()
		}
		n.Set(e.Model, allowed)
		cur.Set("modelWire", n)
	case "model-efforts":
		ef := []any{}
		for _, x := range e.Efforts {
			for _, k := range efforts {
				if x == k {
					ef = append(ef, x)
					break
				}
			}
		}
		if len(ef) == 0 || e.Model == "" {
			s.unlock()
			return
		}
		ms := asObj(cur.Get("models"))
		var prevModel *u.Obj
		if ms != nil {
			prevModel = asObj(ms.Get(e.Model))
		}
		if prevModel != nil && prevModel.Get("catalogVersion") == e.CatalogVersion && u.Stringify(prevModel.Get("efforts")) == u.Stringify(ef) {
			s.unlock()
			return
		}
		nm := u.NewObj()
		if prevModel != nil {
			nm = prevModel.Clone()
		}
		at := e.At
		if math.IsInf(at, 0) || math.IsNaN(at) {
			at = Now()
		}
		nm.Set("at", at).Set("catalogVersion", e.CatalogVersion).Set("efforts", ef)
		n := u.NewObj()
		if ms != nil {
			n = ms.Clone()
		}
		n.Set(e.Model, nm)
		cur.Set("models", n)
	case "custom-tools-refused":
		ct := arr(cur.Get("customToolsRefused"))
		if containsAny(ct, e.Model) {
			s.unlock()
			return
		}
		cur.Set("customToolsRefused", append(append([]any{}, ct...), e.Model))
	case "wire-suspect":
		s.unlock()
		s.learnWireSuspect(p, e)
		return
	default:
		s.unlock()
		s.logger.Info("gateway learn event ignored", map[string]any{"type": e.Type})
		return
	}
	s.logger.Info("gateway learned", e.Obj())
	s.Store.SetLearned(pid, cur)
	_ = s.commitUnlock()
}

// DetectFunc：detect()（probe/detect.ts）的注入点；返回 wires[wire].ok
type DetectFunc func(in *u.Obj) (*u.Obj, error)

func (s *Service) learnWireSuspect(p *u.Obj, e server.LearnEvent) {
	s.lock() // p 是存储里的活对象，读它也要持锁
	urls := asObj(p.Get("urls"))
	url, _ := strOf(urls.Get(e.Wire))
	if url == "" {
		s.unlock()
		return
	}
	pid := idOf(p)
	keys := []any{}
	for _, kr := range arr(p.Get("keys")) {
		k := asObj(kr)
		if !u.Truthy(k.Get("enabled")) {
			continue
		}
		if v, ok := s.Store.Decrypt(k.Get("enc"), k.Get("encryption")); ok {
			keys = append(keys, u.NewObj("id", k.Get("id"), "value", v))
		}
	}
	in := u.NewObj("bases", u.NewObj(e.Wire, url), "keys", keys)
	for _, mr := range arr(p.Get("models")) {
		if m := asObj(mr); m != nil && u.Truthy(m.Get("enabled")) {
			in.Set("fallbackModel", m.Get("id"))
			break
		}
	}
	if !in.Has("fallbackModel") {
		in.Set("fallbackModel", u.Undefined)
	}
	in.Set("allowedPrivateHosts", s.Store.Snapshot().Get("allowedPrivateHosts"))
	if st := s.rt.proc.GetStatus(); st.State == "running" {
		in.Set("selfPort", float64(st.Port))
	}
	gen := s.rt.learnGen[pid]
	s.unlock()
	r, err := s.detectFn()(in)
	if err != nil || r == nil {
		return
	}
	if w := asObj(asObj(r.Get("wires")).Get(e.Wire)); w != nil && u.Truthy(w.Get("ok")) {
		return
	}
	s.lock()
	now := s.findProvider(pid)
	var nowURL any
	if now != nil {
		nowURL = asObj(now.Get("urls")).Get(e.Wire)
	}
	if s.rt.learnGen[pid] != gen || nowURL != url {
		s.unlock()
		return
	}
	latest := s.learnedOf(pid)
	wd := u.NewObj()
	if o := asObj(latest.Get("wireDown")); o != nil {
		wd = o.Clone()
	}
	wd.Set(e.Wire, u.NewObj("at", Now(), "reason", e.Reason))
	latest.Set("wireDown", wd)
	s.logger.Info("gateway learned", e.Obj())
	s.Store.SetLearned(pid, latest)
	_ = s.commitUnlock()
}

// KeyStatus = keyStatus(e)：只落盘、通知界面，不推配置
func (s *Service) KeyStatus(e upstream.KeyStatusEvent) {
	s.lock()
	p := s.findProvider(e.ProviderID)
	var k *u.Obj
	if p != nil {
		for _, kr := range arr(p.Get("keys")) {
			if x := asObj(kr); x != nil && x.Get("id") == e.KeyID {
				k = x
				break
			}
		}
	}
	if p == nil || k == nil {
		s.unlock()
		return
	}
	label, ok := wireLabel[e.Wire]
	if !ok {
		label = e.Wire
	}
	errS := ""
	if e.Error != nil {
		errS = *e.Error
	}
	var next any = u.Undefined
	switch e.Status {
	case "ok":
	case "auth":
		next = i18n.T("electron.common.authentication-failed", label, errS)
	default:
		next = i18n.T("electron.common.rate-limited", label, errS)
	}
	last := k.Get("lastError")
	if last == nil && !k.Has("lastError") {
		last = u.Undefined
	}
	if last == next {
		s.unlock()
		return
	}
	np := p.Clone()
	ks := []any{}
	for _, kr := range arr(p.Get("keys")) {
		x := asObj(kr)
		if x != nil && x.Get("id") == idOf(k) {
			c := x.Clone()
			c.Set("lastError", next)
			ks = append(ks, c)
		} else {
			ks = append(ks, kr)
		}
	}
	np.Set("keys", ks)
	s.Store.UpsertProvider(np)
	_ = s.Store.Save()
	s.unlock()
	s.changed()
}

// ConfirmPrivateHost = confirmPrivateHost(hostPort)
func (s *Service) ConfirmPrivateHost(hostPort string) error {
	hp := u.JSLower(u.JSTrim(hostPort))
	if !hostPortRe.MatchString(hp) {
		return trErr("electron.common.the-address-must-be-host-port")
	}
	s.lock()
	data := s.Store.Snapshot()
	list := arr(data.Get("allowedPrivateHosts"))
	if !containsAny(list, hp) {
		list = append(append([]any{}, list...), hp)
	}
	data.Set("allowedPrivateHosts", list)
	s.Store.Replace(data)
	return s.commitUnlock()
}

// Retry = retry()
func (s *Service) Retry() { s.rt.proc.Retry() }

// ApplyModelsData = applyModelsData(api)：返回在后台写盘完成时关闭的 channel
func (s *Service) ApplyModelsData(api any) <-chan struct{} {
	done := make(chan struct{})
	date := time.UnixMilli(int64(Now())).UTC().Format("2006-01-02")
	r := models.BuildCatalog(api, date)
	doc := r.CatalogDoc
	if n := len(doc.Models.Keys()); n < minSyncedModels {
		s.logger.Warn("models data sync: too few models, keeping the current catalog", map[string]any{"count": n})
		close(done)
		return done
	}
	_ = os.MkdirAll(s.rt.d.Root, 0o755)
	models.SetCatalogOverlay(&doc)
	s.lock()
	s.push()
	s.unlock()
	s.changed()
	data := []byte(u.Stringify(doc.JSON()))
	file := s.catalogFile()
	go func() {
		defer close(done)
		if err := utils.WritePrivateFileAtomic(file, data); err != nil {
			s.logger.Warn("models catalog write failed", map[string]any{"error": err.Error()})
		}
	}()
	return done
}

// LegacyRevokeFailure = setLegacyRevoke 的 failed 条目
type LegacyRevokeFailure struct{ Kind, Error string }

// SetLegacyRevoke = setLegacyRevoke(r)
func (s *Service) SetLegacyRevoke(revoked []string, failed []LegacyRevokeFailure) {
	s.lock()
	if len(revoked) > 0 || len(failed) > 0 {
		rv := make([]any, len(revoked))
		for i, x := range revoked {
			rv[i] = x
		}
		fl := make([]any, len(failed))
		for i, f := range failed {
			fl[i] = u.NewObj("kind", f.Kind, "error", f.Error)
		}
		s.rt.legacyRevoke = u.NewObj("revoked", rv, "failed", fl)
	} else {
		s.rt.legacyRevoke = nil
	}
	s.push()
	s.unlock()
	s.changed()
}

// Tabs = tabs（第三方标签的路由令牌）
func (s *Service) Tabs() *TabTokens { return s.rt.tabs }
