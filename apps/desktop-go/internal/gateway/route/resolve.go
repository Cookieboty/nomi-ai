package route

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/clients"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Resolution is ResolveResult.resolution.
type Resolution struct {
	How  string
	Note string // "" = absent
}

// JSON is the resolution object.
func (r *Resolution) JSON() *u.Obj {
	o := u.NewObj("how", r.How)
	if r.Note != "" {
		o.Set("note", r.Note)
	}
	return o
}

// ResolveResult is ResolveResult.
type ResolveResult struct {
	OK          bool
	Candidates  []*cand.Candidate
	Resolution  *Resolution
	Status      int
	Message     string
	Suggestions []string // nil = absent
}

// SplitRef is splitRef (provider "" = null; `i > 0` so a leading / is no prefix).
func SplitRef(ref string) (string, string) {
	if i := strings.Index(ref, "/"); i > 0 {
		return ref[:i], ref[i+1:]
	}
	return "", ref
}

// FindProvider is findProvider.
func FindProvider(cfg *config.GatewayConfig, id string) *config.RuntimeProvider {
	for i := range cfg.Providers {
		if p := &cfg.Providers[i]; p.Enabled && p.ID == id {
			return p
		}
	}
	for i := range cfg.Providers {
		if p := &cfg.Providers[i]; p.Enabled && has(p.Aliases, id) {
			return p
		}
	}
	return nil
}

// MappedModel is MappedModel.
type MappedModel struct {
	Ref, How, Note string
}

func truthyStr(p *string) bool { return p != nil && *p != "" }

// MapModel is mapModel (client "" = null; models nil = undefined).
func MapModel(client string, m *config.ClientModels, requested string, bound bool) *MappedModel {
	if m == nil {
		return nil
	}
	dflt := "default"
	if bound {
		dflt = "binding"
	}
	if requested == "" {
		if truthyStr(m.Main) {
			return &MappedModel{Ref: *m.Main, How: dflt}
		}
		return nil
	}
	spec := clients.ClientSpecOf(client)
	if spec == nil {
		return nil
	}
	if hit := clients.BuiltinSlot(spec, requested); hit != nil {
		ref := clients.SlotModel(m, hit.Slot)
		if !truthyStr(ref) {
			return nil
		}
		fellBack := hit.Slot != "main" && !clients.SlotIsSet(m, hit.Slot)
		how := hit.How
		if hit.How == "default" || fellBack {
			how = dflt
		}
		return &MappedModel{Ref: *ref, How: how}
	}
	if !truthyStr(m.Main) {
		return nil
	}
	if bound {
		return &MappedModel{Ref: *m.Main, How: "unknown", Note: "未知模型名 " + requested + "，已按标签主模型处理"}
	}
	if spec.UnknownToMain {
		return &MappedModel{Ref: *m.Main, How: "default"}
	}
	return nil
}

func hasModel(p *config.RuntimeProvider, id string) bool { return p.Model(id) != nil }

// resolveRefOff = resolveRef：先按启用的供应商解析（resolveRefOn）；指向已停用的供应商时返回它并标 disabled：
// 自己不出候选，直接按列表顺序回退到同一个模型（§7.2）
func resolveRefOff(cfg *config.GatewayConfig, ref, homeProvider string) (*config.RuntimeProvider, string, bool) {
	p, m := resolveRefOn(cfg, ref, homeProvider)
	if p != nil {
		return p, m, false
	}
	pid, model := SplitRef(ref)
	if pid == "" {
		return nil, "", false
	}
	for i := range cfg.Providers {
		if x := &cfg.Providers[i]; !x.Enabled && x.ID == pid {
			return x, model, true
		}
	}
	for i := range cfg.Providers {
		if x := &cfg.Providers[i]; !x.Enabled && has(x.Aliases, pid) {
			return x, model, true
		}
	}
	return nil, "", false
}

// resolveRefOn：只看启用的供应商（§6.2 第 1～3 步）
func resolveRefOn(cfg *config.GatewayConfig, ref, homeProvider string) (*config.RuntimeProvider, string) {
	pid, model := SplitRef(ref)
	if pid != "" {
		if p := FindProvider(cfg, pid); p != nil {
			return p, model
		}
	}
	if homeProvider != "" {
		if home := FindProvider(cfg, homeProvider); home != nil && hasModel(home, ref) {
			return home, ref
		}
	}
	var hit *config.RuntimeProvider
	n := 0
	for i := range cfg.Providers {
		if p := &cfg.Providers[i]; p.Enabled && hasModel(p, ref) {
			hit = p
			n++
		}
	}
	if n == 1 {
		return hit, ref
	}
	return nil, ""
}

func upstreamName(p *config.RuntimeProvider, model string) string {
	for _, m := range p.ModelMap {
		if m.From == model {
			return m.To
		}
	}
	return model
}

var headSplit = regexp.MustCompile(`[-_.]`)

func suggest(cfg *config.GatewayConfig, requested string) []string {
	_, m := SplitRef(requested)
	q := u.JSLower(m)
	head := headSplit.Split(q, 2)[0]
	out := []string{}
	for i := range cfg.Providers {
		p := &cfg.Providers[i]
		if !p.Enabled {
			continue
		}
		for _, x := range p.Models {
			if !x.Enabled {
				continue
			}
			r := p.ID + "/" + x.ID
			l := u.JSLower(r)
			if strings.Contains(l, q) || (u.UTF16Len(head) >= 3 && strings.Contains(l, head)) {
				out = append(out, r)
				if len(out) == 3 {
					return out
				}
			}
		}
	}
	return out
}

func learnedOf(cfg *config.GatewayConfig, id string) *config.LearnedState {
	if cfg.Learned == nil {
		return nil
	}
	return cfg.Learned[id]
}

func withDrops(c *cand.Candidate, learned *config.LearnedState) *cand.Candidate {
	drops := []string{}
	add := func(xs []string) {
		for _, x := range xs {
			if !has(drops, x) {
				drops = append(drops, x)
			}
		}
	}
	add(providers.QuirksOf(c.Provider, c.Wire).DropParams)
	if learned != nil {
		add(learned.DroppedParams[c.Wire])
	}
	customOff := c.Wire == "responses" && learned != nil && has(learned.CustomToolsRefused, c.ShortModel())
	if len(drops) == 0 && !customOff {
		return c
	}
	x := c.Clone()
	if len(drops) > 0 {
		x.DropParams = drops
	}
	if customOff {
		x.CustomToolsAsFunctions = true
	}
	return x
}

func effOpts(cfg *config.GatewayConfig) models.EffectiveOpts {
	s := cfg.StrictParams
	return models.EffectiveOpts{Strict: &s}
}

// AlternateWire is alternateWire (nil = null).
func AlternateWire(cfg *config.GatewayConfig, c *cand.Candidate, ingress string, exclude []string) *cand.Candidate {
	model := c.ShortModel()
	learned := learnedOf(cfg, c.Provider.ID)
	usable := []string{}
	for _, w := range WiresFor(c.Provider, model, c.Key, learned, NowMs()) {
		if !has(exclude, w) {
			usable = append(usable, w)
		}
	}
	m := c.Model
	if m == nil {
		m = models.EffectiveModel(c.Provider, model, learned, effOpts(cfg))
	}
	w, plan, ok := chooseWire(cfg, c.Provider, model, m, ingress, usable)
	if !ok {
		return nil
	}
	x := c.Clone()
	x.DropParams, x.CustomToolsAsFunctions = nil, false
	x.Wire, x.Model, x.Plan = w, m, plan
	return withDrops(x, learned)
}

func chooseWire(cfg *config.GatewayConfig, p *config.RuntimeProvider, model string, m *u.Obj, ingress string, usable []string) (string, *cand.RoutePlan, bool) {
	legacy := PickWire(p, model, ingress, usable)
	plan := MakePlan(p, m, ingress, usable)
	if cfg.RoutePlan != "shadow" && plan != nil {
		return plan.Upstream, plan, true
	}
	if legacy == "" {
		return "", nil, false
	}
	if plan != nil {
		x := *plan
		x.Legacy = legacy
		plan = &x
	}
	return legacy, plan, true
}

func expand(cfg *config.GatewayConfig, p *config.RuntimeProvider, model, ingress string) []*cand.Candidate {
	out := []*cand.Candidate{}
	learned := learnedOf(cfg, p.ID)
	um := upstreamName(p, model)
	m := models.EffectiveModel(p, model, learned, effOpts(cfg))
	for i := range p.Keys {
		key := &p.Keys[i]
		if !key.Enabled {
			continue
		}
		if w, plan, ok := chooseWire(cfg, p, model, m, ingress, WiresFor(p, model, key, learned, NowMs())); ok {
			out = append(out, withDrops(&cand.Candidate{Provider: p, Key: key, PublicModel: p.ID + "/" + model, UpstreamModel: um, Wire: w, Model: m, Plan: plan}, learned))
		}
	}
	return out
}

// ResolveCandidates is resolveCandidates (client/ingress "" = null; binding nil = none).
func ResolveCandidates(cfg *config.GatewayConfig, client, requested, ingress string, binding *config.ClientModels) *ResolveResult {
	m := binding
	if m == nil && client != "" {
		if c := cfg.Clients[client]; c != nil {
			m = &c.Models
		}
	}
	home := ""
	if m != nil && truthyStr(m.Main) {
		home, _ = SplitRef(*m.Main)
	}
	var tp *config.RuntimeProvider
	var tm string
	off := false
	if requested != "" {
		tp, tm, off = resolveRefOff(cfg, requested, home)
	}
	res := &Resolution{How: "explicit"}
	if tp == nil {
		if mapped := MapModel(client, m, requested, binding != nil); mapped != nil {
			tp, tm, off = resolveRefOff(cfg, mapped.Ref, home)
			res = &Resolution{How: mapped.How, Note: mapped.Note}
		}
	}
	if tp == nil {
		s := suggest(cfg, requested)
		msg := "Nomi 网关：请求里没有模型名，这个客户端也没有设置默认模型"
		if requested != "" {
			msg = "Nomi 网关：模型 `" + requested + "` 不存在"
			if len(s) > 0 {
				q := make([]string, len(s))
				for i, x := range s {
					q[i] = "`" + x + "`"
				}
				msg += "，最接近的是 " + strings.Join(q, "、")
			}
		}
		return &ResolveResult{Status: 404, Message: msg, Suggestions: s}
	}
	// 停用的供应商自己不出候选：直接从同一个模型的下一家开始
	var cs []*cand.Candidate
	if !off {
		cs = expand(cfg, tp, tm, ingress)
	}
	// 首选的 Key 都不行时：同一个模型，按供应商列表顺序换供应商
	for _, fb := range FailoverTargets(cfg, tp, tm) {
		cs = append(cs, expand(cfg, fb.Provider, fb.Model, ingress)...)
	}
	if len(cs) == 0 {
		if off {
			return &ResolveResult{Status: 400, Message: "Nomi 网关：供应商「" + tp.Name + "」已停用，也没有其它启用的供应商提供 `" + tm + "`"}
		}
		return &ResolveResult{Status: 400, Message: "Nomi 网关：供应商「" + tp.Name + "」没有可用的 Key 或协议地址"}
	}
	return &ResolveResult{OK: true, Candidates: cs, Resolution: res}
}

var (
	modelTagRe    = regexp.MustCompile(`:[\w.-]+$`)
	modelSuffixRe = regexp.MustCompile(`-\d{8}$|-latest$`)
)

// SameModelKey = sameModelKey：去掉供应商前缀、`:free` 等标签与日期 / -latest 后缀，不分大小写（§7.2）
func SameModelKey(id string) string {
	return modelSuffixRe.ReplaceAllString(modelTagRe.ReplaceAllString(models.BareModelID(id), ""), "")
}

// isLocalProvider：供应商的地址全在本机 / 局域网；没有地址时不算。普通域名解析到局域网时只有用户
// 确认过的 host:port 才连得上（§15），这些也算本机 / 局域网（#248）
func isLocalProvider(p *config.RuntimeProvider, allowed map[string]bool) bool {
	n := 0
	for _, w := range p.URLWires() {
		raw := p.URL(w)
		if raw == "" {
			continue
		}
		n++
		pu, err := gnet.ParseURL(raw)
		if err != nil {
			return false
		}
		h := pu.Hostname()
		if strings.HasPrefix(pu.Host, "[") {
			h = "[" + h + "]"
		}
		if !gnet.IsLoopbackHost(h) && !gnet.IsPrivateHost(h) && !allowed[gnet.HostPort(pu)] {
			return false
		}
	}
	return n > 0
}

// FailoverTarget：回退到的供应商与它那边的模型 id
type FailoverTarget struct {
	Provider *config.RuntimeProvider
	Model    string
}

// FailoverTargets = failoverTargets：首选供应商失败后，按供应商列表顺序在其它启用的供应商里找同一个模型
// （且在那边是启用的）；不换成别的模型。首选是本机 / 局域网的，只回退到本机 / 局域网（§7.2）
func FailoverTargets(cfg *config.GatewayConfig, provider *config.RuntimeProvider, model string) []FailoverTarget {
	key := SameModelKey(model)
	allowed := map[string]bool{}
	for _, x := range cfg.AllowedPrivateHosts {
		allowed[strings.ToLower(x)] = true
	}
	localOnly := isLocalProvider(provider, allowed)
	out := []FailoverTarget{}
	for i := range cfg.Providers {
		p := &cfg.Providers[i]
		if p.ID == provider.ID || !p.Enabled {
			continue
		}
		if localOnly && !isLocalProvider(p, allowed) {
			continue
		}
		for _, m := range p.Models {
			if m.Enabled && SameModelKey(m.ID) == key {
				out = append(out, FailoverTarget{Provider: p, Model: m.ID})
				break
			}
		}
	}
	return out
}

// Upstream is one preferredWire upstream.
type Upstream struct{ ProviderID, Name, URL string }

// Preferred is the preferredWire result.
type Preferred struct {
	Wire, PublicModel string
	Upstreams         []Upstream
}

// PreferredWire is preferredWire (nil = null).
func PreferredWire(cfg *config.GatewayConfig, client, ref string) *Preferred {
	r := ResolveCandidates(cfg, client, ref, "", nil)
	if !r.OK {
		return nil
	}
	c := r.Candidates[0]
	routed := ResolveCandidates(cfg, client, ref, c.Wire, nil)
	if !routed.OK {
		return nil
	}
	ups := []Upstream{}
	add := func(x *cand.Candidate, url string) {
		for _, y := range ups {
			if y.ProviderID == x.Provider.ID && y.URL == url {
				return
			}
		}
		ups = append(ups, Upstream{x.Provider.ID, x.Provider.Name, url})
	}
	for _, x := range routed.Candidates {
		add(x, x.Provider.URL(x.Wire))
		for _, w := range x.Provider.URLWires() {
			url := x.Provider.URL(w)
			if url != "" && w != x.Wire && (x.Key.Wire == "" || x.Key.Wire == w) {
				add(x, url)
			}
		}
	}
	return &Preferred{Wire: c.Wire, PublicModel: c.PublicModel, Upstreams: ups}
}
