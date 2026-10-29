package shellhandlers

import (
	"context"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// GatewayInfo = services.gateway() 的 nomiProvider / providerInfo
type GatewayInfo interface {
	NomiProvider(role string) *u.Obj
	ProviderInfo(id string) *u.Obj
}

// DesktopRuntimeHooks = createCore.ts desktop.attachRuntime({ resolveProvider, lookupProvider, complete })
// 与 AIRuntimeBoot.resolveProvider / lookupProvider 一致。
func DesktopRuntimeHooks(svc *providers.Service, reg *providers.RoutedLLMRegistry, gw GatewayInfo,
	send func(ctx context.Context, role string, msgs []blm.ChatMessage) (string, error)) *desktop.RuntimeHooks {
	str := func(v any) string { s, _ := v.(string); return s }
	fromObj := func(o *u.Obj) *desktop.RuntimeProvider {
		if o == nil {
			return nil
		}
		return &desktop.RuntimeProvider{ID: str(o.Get("id")), Name: str(o.Get("name")), BaseURL: str(o.Get("baseURL"))}
	}
	find := func(list any, id string) *u.Obj {
		arr, _ := list.([]any)
		for _, x := range arr {
			if o, ok := x.(*u.Obj); ok && o.Get("id") == id {
				return o
			}
		}
		return nil
	}
	return &desktop.RuntimeHooks{
		ResolveProvider: func(role string) *desktop.RuntimeProvider {
			r := reg.ResolveProvider(role)
			if r == nil || r.Provider == nil {
				return nil
			}
			id := r.Provider.ProviderID()
			// 经统一网关：报真正的上游供应商与地址
			if id == providers.GatewayProviderID {
				if gw == nil {
					return nil
				}
				return fromObj(gw.NomiProvider(role))
			}
			st := svc.State()
			v := find(st.Get("providers"), id)
			if v == nil {
				v = find(st.Get("envProviders"), id)
			}
			out := &desktop.RuntimeProvider{ID: id, Name: id}
			if v != nil {
				if n, ok := v.Get("name").(string); ok {
					out.Name = n
				}
				out.BaseURL = str(v.Get("baseURL"))
			}
			return out
		},
		LookupProvider: func(id string) *desktop.RuntimeProvider {
			if gw != nil {
				if o := gw.ProviderInfo(id); o != nil {
					return fromObj(o)
				}
			}
			return fromObj(find(svc.State().Get("envProviders"), id))
		},
		Complete: func(messages []map[string]string, role desktop.Role) (string, error) {
			cm := make([]blm.ChatMessage, 0, len(messages))
			for _, m := range messages {
				cm = append(cm, blm.ChatMessage{Role: m["role"], Content: m["content"]})
			}
			return send(context.Background(), role, cm)
		},
	}
}
