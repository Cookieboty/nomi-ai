package gwstore

// 第三方供应商链接导入（docs/design/provider-link.md）= GatewayService.findProviderByUrls / importLinkedProvider。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/providerlink"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// findByURLs：调用方持锁
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
		for _, w := range pu.Keys() {
			have, _ := strOf(pu.Get(w))
			if have == "" {
				continue
			}
			for _, v := range urls {
				if providerlink.SameURL(have, v) {
					return p
				}
			}
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
