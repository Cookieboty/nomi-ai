package gwstore

// 第三方供应商链接导入（docs/integrations/provider-link.md）= GatewayService.findProviderByUrls / importLinkedProvider。

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/providerlink"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// findByURLs：调用方持锁。链接里的地址都要和它已有的地址同源：带了别的域名时不合并（新建），
// 免得它已有的 Key 也被发到链接新加的域名（#249）
func (s *Service) findByURLs(urls []string) *u.Obj {
	for _, raw := range s.Store.Providers() {
		p := asObj(raw)
		if p == nil || p.Get("source") == "env" {
			continue
		}
		pu := asObj(p.Get("urls"))
		if pu == nil {
			continue
		}
		have := []string{}
		for _, w := range pu.Keys() {
			if h, _ := strOf(pu.Get(w)); h != "" {
				have = append(have, h)
			}
		}
		same, origins := false, true
		for _, v := range urls {
			in := false
			for _, h := range have {
				if providerlink.SameURL(h, v) {
					same = true
				}
				if providerlink.SameOrigin(h, v) {
					in = true
				}
			}
			origins = origins && in
		}
		if same && origins {
			return p
		}
	}
	return nil
}

// FindProviderByURLs：已有某个地址相同的第三方供应商（环境变量的不算）
func (s *Service) FindProviderByURLs(urls []string) (id, name string, found bool) {
	s.rt.mu.Lock()
	defer s.rt.mu.Unlock()
	p := s.findByURLs(urls)
	if p == nil {
		return "", "", false
	}
	n, _ := strOf(p.Get("name"))
	return idOf(p), n, true
}

func urlList(m map[string]string) []string {
	out := []string{}
	for _, w := range providerlink.Wires {
		if v := m[w]; v != "" {
			out = append(out, v)
		}
	}
	return out
}

func modelObjs(ids []string) []any {
	out := []any{}
	for _, id := range ids {
		out = append(out, u.NewObj("id", id, "enabled", true))
	}
	return out
}

// ImportLinkedProvider：有同地址的就更新它（补 Key、补没填的协议地址与模型，已有同样的 Key 不重复加），否则新建
func (s *Service) ImportLinkedProvider(p providerlink.Provider) (*u.Obj, bool, error) {
	s.rt.mu.Lock()
	prev := s.findByURLs(urlList(p.URLs))
	var (
		prevID, prevName string
		hasKey           bool
		models           []any
		urls             = u.NewObj()
	)
	if prev != nil {
		prev = deepClone(prev).(*u.Obj)
		prevID = idOf(prev)
		prevName, _ = strOf(prev.Get("name"))
		for _, kr := range arr(prev.Get("keys")) {
			if k := asObj(kr); k != nil {
				if v, ok := s.Store.Decrypt(k.Get("enc"), k.Get("encryption")); ok && v == p.Key {
					hasKey = true
				}
			}
		}
		pu := asObj(prev.Get("urls"))
		for _, w := range providerlink.Wires {
			v := p.URLs[w]
			if v == "" {
				continue
			}
			have := ""
			if pu != nil {
				have, _ = strOf(pu.Get(w))
			}
			if u.JSTrim(have) == "" {
				urls.Set(w, v)
			}
		}
		known := map[string]bool{}
		for _, mr := range arr(prev.Get("models")) {
			models = append(models, mr)
			if m := asObj(mr); m != nil {
				id, _ := strOf(m.Get("id"))
				known[id] = true
			}
		}
		for _, id := range p.Models {
			if !known[id] {
				models = append(models, u.NewObj("id", id, "enabled", true))
			}
		}
	}
	s.rt.mu.Unlock()

	if prev == nil {
		for _, w := range providerlink.Wires {
			if v := p.URLs[w]; v != "" {
				urls.Set(w, v)
			}
		}
		view, err := s.UpsertProvider(u.NewObj(
			"name", p.Name,
			"urls", urls,
			"newKeys", []any{u.NewObj("value", p.Key)},
			"models", modelObjs(p.Models),
		))
		return view, false, err
	}
	in := u.NewObj("id", prevID, "name", prevName, "urls", urls, "models", models)
	if models == nil {
		in.Set("models", []any{})
	}
	if !hasKey {
		in.Set("newKeys", []any{u.NewObj("value", p.Key)})
	}
	view, err := s.UpsertProvider(in)
	return view, true, err
}

// PriceAlias：第三方供应商里用户设的「按哪个已知模型处理」（like），用于计价。
// provider 给了按那家查；没给时按模型名查，各家设得一致才用。锁外读已发布快照。
//
// 用量账本记的是实际请求上游的模型名：配了 modelMap（公开名 → 上游名）时，那是映射后的上游名，
// 这里在这家的 modelMap 里反查回公开名再取 like（#256）。多个公开名映射到同一个上游名、like 又不一致
// （或有的没设）时不猜，返回 ""（按未定价处理）
func (s *Service) PriceAlias(model, provider string) string {
	bare := func(x string) string { return strings.ToLower(x[strings.LastIndex(x, "/")+1:]) }
	want := bare(model)
	hit := func(p *u.Obj) string {
		likeOf := map[string]string{} // 模型 id（小写）→ like
		ms, _ := p.Get("models").([]any)
		for _, raw := range ms {
			m := asObj(raw)
			if m == nil {
				continue
			}
			id, _ := strOf(m.Get("id"))
			lk, _ := m.Get("like").(string)
			likeOf[bare(id)] = strings.TrimSpace(lk)
		}
		if lk := likeOf[want]; lk != "" {
			return lk
		}
		// 上游名 → 映射到它的公开名
		likes := map[string]bool{}
		mm, _ := p.Get("modelMap").([]any)
		for _, raw := range mm {
			e := asObj(raw)
			if e == nil {
				continue
			}
			from, _ := strOf(e.Get("from"))
			to, _ := strOf(e.Get("to"))
			if from != "" && bare(to) == want {
				likes[likeOf[bare(from)]] = true
			}
		}
		if len(likes) == 1 {
			for lk := range likes {
				return lk // 唯一且一致（"" = 公开名没设 like）
			}
		}
		return ""
	}
	var ps []*u.Obj
	for _, raw := range s.Store.View().Providers() {
		if p := asObj(raw); p != nil {
			ps = append(ps, p)
		}
	}
	if provider != "" {
		for _, p := range ps {
			if idOf(p) == provider {
				return hit(p)
			}
			al, _ := p.Get("aliases").([]any)
			for _, a := range al {
				if a == provider {
					return hit(p)
				}
			}
		}
	}
	likes := map[string]bool{}
	for _, p := range ps {
		if l := hit(p); l != "" {
			likes[l] = true
		}
	}
	if len(likes) == 1 {
		for l := range likes {
			return l
		}
	}
	return ""
}
