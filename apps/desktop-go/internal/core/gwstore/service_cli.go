package gwstore

// 编程助手（§12）：GatewayService.ts cliDefaults … officialEnv 的 1:1 移植。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func (s *Service) clientObj(kind string) *u.Obj {
	cl, _ := s.Store.Snapshot().Get("clients").(*u.Obj)
	if cl == nil {
		return nil
	}
	c, _ := cl.Get(kind).(*u.Obj)
	return c
}

func clientModelsObj(c *u.Obj) *u.Obj {
	if c == nil {
		return nil
	}
	m, _ := c.Get("models").(*u.Obj)
	return m
}

// CliDefaults = cliDefaults(kind)
func (s *Service) CliDefaults(kind string) *u.Obj {
	c := s.clientObj(kind)
	var model any
	if m := clientModelsObj(c); m != nil {
		if v := m.Get("main"); v != nil {
			model = v
		}
	}
	third := c != nil && c.Get("newTabSource") == "thirdParty"
	source := "official"
	if third && agentsTruthy(model) {
		source = "thirdParty"
	}
	var account any
	if !third && c != nil {
		account = c.Get("newTabAccountId")
	}
	return u.NewObj("source", source, "model", model, "accountId", account)
}

func agentsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return x
	case float64:
		return x != 0 && x == x
	}
	return true
}

func (s *Service) allProviders() []*u.Obj {
	out := []*u.Obj{}
	for _, p := range s.Store.Providers() {
		out = append(out, asObj(p))
	}
	return append(out, s.envViews()...)
}

func objList(v any) []*u.Obj {
	a, _ := v.([]any)
	out := make([]*u.Obj, 0, len(a))
	for _, x := range a {
		out = append(out, asObj(x))
	}
	return out
}

// CliModels = cliModels()
func (s *Service) CliModels() []*u.Obj {
	out := []*u.Obj{}
	for _, p := range s.allProviders() {
		if !agentsTruthy(p.Get("enabled")) {
			continue
		}
		pid := u.JSString(p.Get("id"))
		for _, m := range objList(p.Get("models")) {
			if !agentsTruthy(m.Get("enabled")) || m.Get("toolCalling") == false {
				continue
			}
			mid := u.JSString(m.Get("id"))
			ref := pid + "/" + mid
			meta := s.ModelMetaOf(ref, nil)
			label := m.Get("label")
			if label == nil {
				label = m.Get("id")
			}
			e := u.NewObj("ref", ref, "provider", p.Get("name"), "label", label)
			if meta != nil && meta.Reasoning != nil {
				e.Set("reasoning", *meta.Reasoning)
			}
			if meta != nil && meta.Vision != nil {
				e.Set("vision", *meta.Vision)
			}
			if meta != nil && meta.Source != "default" {
				e.Set("ctx", meta.Ctx)
			}
			out = append(out, e)
		}
	}
	return out
}

// ModelMetaOf = modelMetaOf(ref, { longContext })
func (s *Service) ModelMetaOf(ref string, longContext *bool) *ResolvedModelMeta {
	i := strings.Index(ref, "/")
	if i <= 0 {
		return nil
	}
	pid, mid := ref[:i], ref[i+1:]
	for _, raw := range s.Store.Providers() {
		if p := asObj(raw); p.Get("id") == pid {
			r := s.Store.ModelMeta(p, mid, longContext)
			return &r
		}
	}
	for _, e := range s.envViews() {
		if e.Get("id") == pid {
			r := s.Store.ModelMeta(u.NewObj("presetId", pid[4:], "models", e.Get("models")), mid, longContext)
			return &r
		}
	}
	return nil
}

// AgentMeta = agentMeta(ref, { longContext })
func (s *Service) AgentMeta(ref string, longContext *bool) *agents.ModelMeta {
	meta := s.ModelMetaOf(ref, longContext)
	if meta == nil {
		return nil
	}
	i := strings.Index(ref, "/")
	pid, mid := ref[:i], ref[i+1:]
	var p, m *u.Obj
	for _, x := range s.allProviders() {
		if x.Get("id") == pid {
			p = x
			break
		}
	}
	if p != nil {
		for _, x := range objList(p.Get("models")) {
			if x.Get("id") == mid {
				m = x
				break
			}
		}
	}
	out := &agents.ModelMeta{}
	label := mid
	if m != nil {
		if l := m.Get("label"); l != nil {
			label = u.JSString(l)
		}
	}
	out.Label = &label
	if p != nil {
		name := u.JSString(p.Get("name"))
		out.Provider = &name
	}
	ctx, mo := meta.Ctx, meta.MaxOutput
	out.Ctx, out.MaxOutput = &ctx, &mo
	out.Reasoning, out.Vision = meta.Reasoning, meta.Vision
	return out
}

// AgentDir = agentDir(kind, tabId)：/[^\w-]/g 按 UTF-16 码元替换
func (s *Service) AgentDir(kind, tabID string) string {
	var b strings.Builder
	for _, r := range tabID {
		switch {
		case r == '_' || r == '-' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return filepath.Join(filepath.Dir(s.Store.file), "agents", kind, b.String())
}

// placeholderModelOf
func placeholderModelOf(kind string) string {
	m := builtin.Manifest(kind)
	if m == nil {
		return ""
	}
	cs, _ := m.Get("clientSpec").(*u.Obj)
	if cs == nil {
		return ""
	}
	v, _ := cs.Get("placeholderModel").(string)
	return v
}

// CliLaunchOpts = cliLaunch 的 opts
type CliLaunchOpts struct {
	TabBound    bool
	LongContext *bool
}

// CliLaunch = cliLaunch(kind, tabId, model, opts)；nil = 网关没在运行
func (s *Service) CliLaunch(kind, tabID, model string, o CliLaunchOpts) (*agents.AgentLaunch, error) {
	ph := ""
	if o.TabBound {
		ph = placeholderModelOf(kind)
	}
	ep := s.Endpoint(kind)
	if ep == nil {
		return nil, nil
	}
	catalog := []string{}
	for _, m := range s.CliModels() {
		catalog = append(catalog, u.JSString(m.Get("ref")))
	}
	models := clientModelsObj(s.clientObj(kind))
	if models == nil {
		models = u.NewObj()
	}
	c := &agents.LaunchContext{
		URL: ep.URL, Token: ep.Token, Model: model,
		MetaOf: func(ref string) *agents.ModelMeta {
			if ref == model && o.LongContext != nil {
				return s.AgentMeta(ref, o.LongContext)
			}
			return s.AgentMeta(ref, nil)
		},
		Catalog: catalog, Models: models, Dir: s.AgentDir(kind, tabID),
	}
	if ph != "" {
		c.Placeholder = &ph
	}
	return agents.AgentLaunchFor(kind, c)
}

// TabLaunch = cliLaunchForTab 的结果
type TabLaunch struct {
	*agents.AgentLaunch
	Generation int
}

// Obj：{...launch, env, args, generation}
func (t *TabLaunch) Obj() *u.Obj {
	return t.AgentLaunch.Obj().Set("generation", float64(t.Generation))
}

// tabReadyTimeout = whenReady() 默认 READY_TIMEOUT_MS（0 = 进程默认）
var tabReadyTimeout time.Duration

// CliLaunchForTab = cliLaunchForTab(kind, tabId, model, effort?, longContext?)
func (s *Service) CliLaunchForTab(kind, tabID, model, effort string, longContext *bool) (*TabLaunch, error) {
	ep := s.Endpoint(kind)
	l, err := s.CliLaunch(kind, tabID, model, CliLaunchOpts{TabBound: true, LongContext: longContext})
	if err != nil {
		return nil, err
	}
	if ep == nil || l == nil {
		return nil, nil
	}
	if !s.rt.proc.WhenReady(tabReadyTimeout) {
		return nil, nil
	}
	mo := u.NewObj()
	if m := clientModelsObj(s.clientObj(kind)); m != nil {
		mo = m.Clone()
	}
	mo.Set("main", model)
	var cm config.ClientModels
	if err := json.Unmarshal([]byte(u.Stringify(mo)), &cm); err != nil {
		return nil, err
	}
	reg, err := s.rt.tabs.Register(TabRegisterInput{Client: kind, TabID: tabID, Models: &cm, Effort: effort})
	if err != nil {
		return nil, err
	}
	swap := func(v string) string { return strings.ReplaceAll(v, ep.Token, reg.Token) }
	env := u.NewObj()
	for _, k := range l.Env.Keys() {
		env.Set(k, swap(u.JSString(l.Env.Get(k))))
	}
	args := make([]string, len(l.Args))
	for i, a := range l.Args {
		args[i] = swap(a)
	}
	return &TabLaunch{AgentLaunch: &agents.AgentLaunch{Env: env, Args: args, Strip: l.Strip, ModelInConfig: l.ModelInConfig}, Generation: reg.Generation}, nil
}

// ReleaseTab = releaseTab(kind, tabId, generation?)；generation<0 = 不指定
func (s *Service) ReleaseTab(kind, tabID string, generation int) {
	s.rt.tabs.Remove(kind, tabID, generation)
}

// ReleaseAgent = releaseAgent(kind, tabId)
func (s *Service) ReleaseAgent(kind, tabID string) {
	if err := os.RemoveAll(s.AgentDir(kind, tabID)); err != nil {
		s.logger.Warn("gateway agent dir cleanup failed", err)
	}
}

// OfficialEnv = officialEnv(env)
func (s *Service) OfficialEnv(env *u.Obj) *u.Obj {
	st := s.rt.proc.GetStatus()
	url := ""
	if st.State == "running" {
		url = st.URL
	} else {
		url = s.configuredURL()
	}
	if url == "" {
		return env
	}
	tokens := []string{}
	for _, c := range config.ClientIDs {
		if t, ok := s.Store.ClientToken(c); ok && t != "" {
			tokens = append(tokens, t)
		}
	}
	return agents.StripGatewayLeftovers(env, url, tokens)
}
