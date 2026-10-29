package mediahandlers

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// GatewayLike = AIRuntimeBoot 的 providerCredentials / listProviders 所走的 services.gateway()
type GatewayLike interface {
	Credentials(id string) *u.Obj
	ListOpenAiCompatible() []any
}

func gwStr(o *u.Obj, k string) string { s, _ := o.Get(k).(string); return s }

// GatewayProviders = createCore: providers: () => rt?.listProviders() ?? []
func GatewayProviders(g func() GatewayLike) func() []voice.Provider {
	return func() []voice.Provider {
		out := []voice.Provider{}
		gw := g()
		if gw == nil {
			return out
		}
		for _, raw := range gw.ListOpenAiCompatible() {
			if o, ok := raw.(*u.Obj); ok {
				out = append(out, voice.Provider{ID: gwStr(o, "id"), Name: gwStr(o, "name"), BaseURL: gwStr(o, "baseURL")})
			}
		}
		return out
	}
}

// GatewayCredentials = createCore: credentials: (id) => rt?.providerCredentials(id) ?? null
func GatewayCredentials(g func() GatewayLike) func(string) *voice.Credentials {
	return func(id string) *voice.Credentials {
		gw := g()
		if gw == nil {
			return nil
		}
		o := gw.Credentials(id)
		if o == nil {
			return nil
		}
		return &voice.Credentials{ID: gwStr(o, "id"), Name: gwStr(o, "name"), BaseURL: gwStr(o, "baseURL"), APIKey: gwStr(o, "apiKey")}
	}
}
