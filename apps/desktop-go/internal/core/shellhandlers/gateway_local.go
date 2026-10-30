package shellhandlers

// LocalGateway：createCore 的 `gateway: () => services.gateway ?? null` 交给 LocalModelService（D-B8-2）。
// providers 取 gw.state().providers（含环境变量视图），useAsChat = setAssignment('nomi', {models:{main}})。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type localGateway struct{ s *gwstore.Service }

// LocalGateway：svc 为 nil 时返回 nil（= services.gateway ?? null）
func LocalGateway(svc *gwstore.Service) func() local.GatewayLike {
	return func() local.GatewayLike {
		if svc == nil {
			return nil
		}
		return localGateway{svc}
	}
}

func (g localGateway) Providers() []local.GatewayProvider {
	out := []local.GatewayProvider{}
	ps, _ := g.s.State().Get("providers").([]any)
	for _, p := range ps {
		o, _ := p.(*u.Obj)
		if o == nil {
			continue
		}
		id, _ := o.Get("id").(string)
		pre, _ := o.Get("presetId").(string)
		out = append(out, local.GatewayProvider{ID: id, PresetID: pre})
	}
	return out
}

func (g localGateway) UpsertProvider(in local.GatewayUpsert) (string, error) {
	o := u.NewObj()
	if in.ID != "" {
		o.Set("id", in.ID)
	}
	urls := u.NewObj()
	for _, k := range []string{"messages", "responses", "chat", "gemini"} {
		if v, ok := in.URLs[k]; ok {
			urls.Set(k, v)
		}
	}
	ms := make([]any, len(in.Models))
	for i, m := range in.Models {
		ms[i] = u.NewObj("id", m.ID, "enabled", m.Enabled)
	}
	o.Set("name", in.Name).Set("presetId", in.PresetID).Set("urls", urls).Set("models", ms)
	v, err := g.s.UpsertProvider(o)
	if err != nil || v == nil {
		return "", err
	}
	id, _ := v.Get("id").(string)
	return id, nil
}

func (g localGateway) SetNomiMain(model string) error {
	return g.s.SetAssignment("nomi", u.NewObj("models", u.NewObj("main", model)))
}

func (g localGateway) ConfirmPrivateHost(hostPort string) error {
	return g.s.ConfirmPrivateHost(hostPort)
}
