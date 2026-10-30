package gwstore

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore/agents"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// allProviders：锁外读，取自已发布快照（只读）
func (s *Service) allProviders() []*u.Obj {
	out := []*u.Obj{}
	for _, p := range s.Store.View().Providers() {
		if o := asObj(p); o != nil {
			out = append(out, o)
		}
	}
	return append(out, s.envViews()...)
}

// CliModels = GatewayService.cliModels()
func (s *Service) CliModels() []*u.Obj {
	out := []*u.Obj{}
	for _, p := range s.allProviders() {
		if !u.Truthy(p.Get("enabled")) {
			continue
		}
		pid, _ := p.Get("id").(string)
		ms, _ := p.Get("models").([]any)
		for _, mv := range ms {
			m := asObj(mv)
			if m == nil || !u.Truthy(m.Get("enabled")) || m.Get("toolCalling") == false {
				continue
			}
			mid, _ := m.Get("id").(string)
			ref := pid + "/" + mid
			meta := s.ModelMetaOf(ref, nil)
			label := m.Get("label")
			if label == nil {
				label = m.Get("id")
			}
			o := u.NewObj("ref", ref, "provider", p.Get("name"), "label", label)
			if meta != nil {
				if meta.Reasoning != nil {
					o.Set("reasoning", *meta.Reasoning)
				}
				if meta.Vision != nil {
					o.Set("vision", *meta.Vision)
				}
				if meta.Source != "default" {
					o.Set("ctx", meta.Ctx)
				}
			}
			out = append(out, o)
		}
	}
	return out
}

// ModelMetaOf = GatewayService.modelMetaOf(ref, {longContext})
func (s *Service) ModelMetaOf(ref string, longContext *bool) *ResolvedModelMeta {
	i := strings.Index(ref, "/")
	if i <= 0 {
		return nil
	}
	pid, mid := ref[:i], ref[i+1:]
	st := s.Store.View()
	for _, pv := range st.Providers() {
		if p := asObj(pv); p != nil && p.Get("id") == pid {
			r := st.ModelMeta(p, mid, longContext)
			return &r
		}
	}
	for _, e := range s.envViews() {
		if e.Get("id") == pid {
			r := st.ModelMeta(u.NewObj("presetId", pid[4:], "models", e.Get("models")), mid, longContext)
			return &r
		}
	}
	return nil
}

// AgentMeta = GatewayService.agentMeta(ref, {longContext})
func (s *Service) AgentMeta(ref string, longContext *bool) *agents.ModelMeta {
	meta := s.ModelMetaOf(ref, longContext)
	if meta == nil {
		return nil
	}
	i := strings.Index(ref, "/")
	pid := ref[:i]
	var p, m *u.Obj
	for _, x := range s.allProviders() {
		if x.Get("id") == pid {
			p = x
			break
		}
	}
	if p != nil {
		ms, _ := p.Get("models").([]any)
		for _, mv := range ms {
			if o := asObj(mv); o != nil && o.Get("id") == ref[i+1:] {
				m = o
				break
			}
		}
	}
	label := ref[i+1:]
	if m != nil {
		if l, ok := m.Get("label").(string); ok {
			label = l
		}
	}
	out := &agents.ModelMeta{Label: &label, Ctx: &meta.Ctx, MaxOutput: &meta.MaxOutput, Reasoning: meta.Reasoning, Vision: meta.Vision}
	if p != nil {
		if n, ok := p.Get("name").(string); ok {
			out.Provider = &n
		}
	}
	return out
}
