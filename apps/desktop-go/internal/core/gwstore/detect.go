package gwstore

// detect.go = GatewayService.detect（§8 探测入口）+ 默认 detect 实现（probe/detect.ts）。

import (
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/probe"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ProbeDetect：DetectFunc 的默认实现（detectImpl 未注入时的 detect）
func ProbeDetect(in *u.Obj) (*u.Obj, error) {
	o := probe.Options{Bases: asObj(in.Get("bases"))}
	for _, kr := range arr(in.Get("keys")) {
		k := asObj(kr)
		id, _ := strOf(k.Get("id"))
		v, _ := strOf(k.Get("value"))
		o.Keys = append(o.Keys, probe.Key{ID: id, Value: v})
	}
	o.FallbackModel, _ = strOf(in.Get("fallbackModel"))
	for _, h := range arr(in.Get("allowedPrivateHosts")) {
		if s, ok := h.(string); ok {
			o.AllowedPrivateHosts = append(o.AllowedPrivateHosts, s)
		}
	}
	if p, ok := in.Get("selfPort").(float64); ok {
		o.SelfPort = int(p)
	}
	return probe.Detect(o), nil
}

func (s *Service) detectFn() DetectFunc {
	if s.rt != nil && s.rt.d.Detect != nil {
		return s.rt.d.Detect
	}
	return ProbeDetect
}

// Detect = detect(input)：可传新填的地址和 Key，也可只传已保存的供应商 id
func (s *Service) Detect(input *u.Obj) (*u.Obj, error) {
	s.lock()
	var saved *u.Obj
	if id, ok := strOf(input.Get("providerId")); ok && id != "" {
		saved = s.findProvider(id)
	}
	bases := u.NewObj()
	merge := func(o *u.Obj) {
		if o == nil {
			return
		}
		for _, k := range o.Keys() {
			bases.Set(k, o.Get(k))
		}
	}
	if raw, ok := strOf(input.Get("url")); ok && raw != "" {
		merge(probe.NormalizeBases(raw))
	}
	if saved != nil {
		merge(asObj(saved.Get("urls")))
	}
	merge(asObj(input.Get("urls")))
	keys := []any{}
	var savedIDs []any
	hasSavedIDs := input.Get("savedKeyIds") != nil && input.Get("savedKeyIds") != u.Undefined
	if hasSavedIDs {
		savedIDs = arr(input.Get("savedKeyIds"))
	}
	if saved != nil {
		for _, kr := range arr(saved.Get("keys")) {
			k := asObj(kr)
			if hasSavedIDs {
				if !containsAny(savedIDs, k.Get("id")) {
					continue
				}
			} else if !u.Truthy(k.Get("enabled")) {
				continue
			}
			if v, ok := s.Store.Decrypt(k.Get("enc"), k.Get("encryption")); ok && v != "" {
				keys = append(keys, u.NewObj("id", k.Get("id"), "value", v))
			}
		}
	}
	for i, vr := range arr(input.Get("keys")) {
		v, _ := strOf(vr)
		if t := u.JSTrim(v); t != "" {
			keys = append(keys, u.NewObj("id", "new-"+strconv.Itoa(i), "value", t))
		}
	}
	in := u.NewObj("bases", bases, "keys", keys, "fallbackModel", input.Get("fallbackModel"),
		"allowedPrivateHosts", s.Store.Snapshot().Get("allowedPrivateHosts"))
	if s.rt != nil {
		if st := s.rt.proc.GetStatus(); st.State == "running" {
			in.Set("selfPort", float64(st.Port))
		}
	}
	s.unlock()
	return s.detectFn()(in)
}
