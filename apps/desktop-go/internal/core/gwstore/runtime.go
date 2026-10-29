package gwstore

// runtime.go = GatewayStore 的 modelMeta / runtimeModels / quirksOf / runtimeConfig / runtimePrivacy：
// 推给网关的快照，Key 与令牌解密后只在内存里。

import (
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// PresetDeps = GatewayStore 的 presetQuirks / presetModels（nil = 未注入，同 Node 可选依赖）
type PresetDeps struct {
	Quirks func(presetID any) *u.Obj
	Models func(presetID any) []any
}

// FindPresetDeps：createCore 的接法 findPreset(id)?.quirks / findPreset(id)?.modelMeta
func FindPresetDeps() PresetDeps {
	return PresetDeps{
		Quirks: func(id any) *u.Obj {
			if p := providers.FindPreset(id); p != nil {
				return asObj(p.Get("quirks"))
			}
			return nil
		},
		Models: func(id any) []any {
			if p := providers.FindPreset(id); p != nil {
				a, _ := p.Get("modelMeta").([]any)
				return a
			}
			return nil
		},
	}
}

// SetPresetDeps 注入预设查询
func (s *Store) SetPresetDeps(d PresetDeps) { s.preset = d }

// ModelMeta = modelMeta(p, modelId, opts)
func (s *Store) ModelMeta(p *u.Obj, modelID string, longContext *bool) ResolvedModelMeta {
	var stored *u.Obj
	ms, _ := p.Get("models").([]any)
	for _, m := range ms {
		if o := asObj(m); o != nil && o.Get("id") == modelID {
			stored = o
			break
		}
	}
	var list []any
	if s.preset.Models != nil {
		list = s.preset.Models(p.Get("presetId"))
	}
	return ResolveModelMeta(stored, modelID, PresetEntry(list, modelID), longContext)
}

func fromConfig(src string) bool { return src != "catalog" && src != "default" }

func (s *Store) runtimeModels(p *u.Obj) []any {
	ms, _ := p.Get("models").([]any)
	out := make([]any, 0, len(ms))
	for _, m := range ms {
		mo := asObj(m)
		id, _ := mo.Get("id").(string)
		r := s.ModelMeta(p, id, nil)
		cv, cs := r.Ctx, r.Source
		if r.LongContext != nil {
			cv, cs = r.LongContext.Full, r.LongContext.FullSource
		}
		n := mo.Clone()
		if fromConfig(cs) {
			n.Set("ctx", cv)
		}
		if fromConfig(r.MaxOutputSource) {
			n.Set("maxOutput", r.MaxOutput)
		}
		out = append(out, n)
	}
	return out
}

func (s *Store) quirksOf(p *u.Obj) *u.Obj {
	var preset *u.Obj
	if s.preset.Quirks != nil {
		preset = s.preset.Quirks(p.Get("presetId"))
	}
	own := asObj(p.Get("quirks"))
	if preset == nil && own == nil {
		return nil
	}
	o := u.NewObj()
	for _, src := range []*u.Obj{preset, own} {
		if src != nil {
			for _, k := range src.Keys() {
				o.Set(k, src.Get(k))
			}
		}
	}
	return o
}

// RuntimeExtra = runtimeConfig(extra)
type RuntimeExtra struct {
	LegacyToken  string
	EnvProviders []any
}

func setIf(o *u.Obj, k string, v any) {
	if u.Truthy(v) {
		o.Set(k, v)
	}
}

// RuntimeConfig = runtimeConfig(extra)：GatewayConfig 的 JS 对象（键序同 Node）
func (s *Store) RuntimeConfig(extra RuntimeExtra) *u.Obj {
	provs := []any{}
	for _, raw := range s.Providers() {
		p := asObj(raw)
		o := u.NewObj("id", p.Get("id"))
		setIf(o, "aliases", p.Get("aliases"))
		o.Set("name", p.Get("name")).Set("enabled", p.Get("enabled")).Set("urls", p.Get("urls"))
		setIf(o, "preset", p.Get("presetId"))
		ks, _ := p.Get("keys").([]any)
		keys := []any{}
		if len(ks) == 0 {
			keys = append(keys, u.NewObj("id", "none", "value", "", "enabled", true))
		}
		for _, kr := range ks {
			k := asObj(kr)
			v, ok := s.Decrypt(k.Get("enc"), k.Get("encryption"))
			if !ok {
				continue
			}
			ko := u.NewObj("id", k.Get("id"))
			setIf(ko, "name", k.Get("name"))
			ko.Set("value", v)
			setIf(ko, "wire", k.Get("wire"))
			ko.Set("enabled", k.Get("enabled"))
			setIf(ko, "maxConcurrency", k.Get("maxConcurrency"))
			setIf(ko, "rpm", k.Get("rpm"))
			keys = append(keys, ko)
		}
		o.Set("keys", keys).Set("models", s.runtimeModels(p))
		for _, k := range []string{"fallback", "headers", "userAgent", "modelMap"} {
			setIf(o, k, p.Get(k))
		}
		if det := asObj(p.Get("detected")); det != nil && u.Truthy(p.Get("detected")) {
			d := u.NewObj()
			for _, w := range det.Keys() {
				r := asObj(det.Get(w))
				ro := u.NewObj("ok", r.Get("ok"))
				setIf(ro, "auth", r.Get("auth"))
				d.Set(w, ro)
			}
			o.Set("detected", d)
		}
		if q := s.quirksOf(p); q != nil {
			o.Set("quirks", q)
		}
		provs = append(provs, o)
	}
	provs = append(provs, extra.EnvProviders...)
	clients := u.NewObj()
	cs := s.clients()
	for _, id := range config.ClientIDs {
		c := asObj(cs.Get(id))
		if c == nil {
			continue
		}
		if token, ok := s.Decrypt(c.Get("tokenEnc"), c.Get("tokenEncryption")); ok && token != "" {
			clients.Set(id, u.NewObj("token", token, "models", c.Get("models")))
		}
	}
	d := s.data
	out := u.NewObj("host", "127.0.0.1", "port", d.Get("port"), "providers", provs, "clients", clients)
	if extra.LegacyToken != "" {
		out.Set("legacyToken", extra.LegacyToken)
	}
	out.Set("allowedPrivateHosts", d.Get("allowedPrivateHosts")).Set("learned", d.Get("learned"))
	if u.Truthy(d.Get("strictParams")) {
		out.Set("strictParams", true)
	}
	if n, ok := d.Get("maxRequestBodyBytes").(float64); ok {
		out.Set("maxRequestBodyBytes", float64(config.ClampMaxRequestBodyBytes(&n)))
	}
	out.Set("privacy", s.runtimePrivacy())
	return out
}

func (s *Store) runtimePrivacy() *u.Obj {
	d := s.data
	known := []any{}
	ss, _ := d.Get("privacySecrets").([]any)
	for _, r := range ss {
		x := asObj(r)
		if v, ok := s.Decrypt(x.Get("enc"), x.Get("encryption")); ok && v != "" {
			known = append(known, u.NewObj("kind", "CUSTOM", "value", v))
		}
	}
	o := u.NewObj("enabled", d.Get("privacyMode") != false)
	if u.Truthy(d.Get("privacyStrict")) {
		o.Set("strict", true)
	}
	if u.Truthy(d.Get("privacyLocal")) {
		o.Set("local", true)
	}
	if u.Truthy(d.Get("privacyShape")) {
		o.Set("shape", true)
	}
	o.Set("key", s.PrivacyKey())
	if a := asObj(d.Get("privacyActions")); a != nil && len(a.Keys()) > 0 {
		o.Set("actions", a.Clone())
	}
	if len(known) > 0 {
		o.Set("known", known)
	}
	if al, _ := d.Get("privacyAllow").([]any); len(al) > 0 {
		tags := make([]any, len(al))
		for i, a := range al {
			tags[i] = asObj(a).Get("tag")
		}
		o.Set("allow", tags)
	}
	return o
}

// ToGatewayConfig：JS 快照 → 网关进程收到的 GatewayConfig（同 structured clone 的 postMessage）
func ToGatewayConfig(o *u.Obj) (*config.GatewayConfig, error) {
	var c config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(o)), &c); err != nil {
		return nil, err
	}
	return &c, nil
}
