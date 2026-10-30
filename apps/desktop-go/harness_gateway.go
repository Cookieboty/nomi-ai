package main

// harnessGateway：apps/desktop-electron/internal/core/src/gateway/harnessGateway.ts 的 1:1 移植（unified-gateway.md §12）。

import (
	"encoding/json"
	"log"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type harnessGateway struct{ g *gwstore.Service }

var (
	_ ports.HarnessGateway     = harnessGateway{}
	_ ports.HarnessGatewayTabs = harnessGateway{}
)

func strPtrOf(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func (h harnessGateway) Defaults(kind string) ports.GatewayDefaults {
	d := h.g.CliDefaults(kind)
	src, _ := d.Get("source").(string)
	return ports.GatewayDefaults{Source: src, Model: strPtrOf(d.Get("model")), AccountId: strPtrOf(d.Get("accountId"))}
}

func (h harnessGateway) Launch(kind, tabID, model string, opts *ports.GatewayLaunchOpts) *ports.GatewayLaunch {
	o := gwstore.CliLaunchOpts{}
	if opts != nil {
		o = gwstore.CliLaunchOpts{TabBound: opts.TabBound, LongContext: opts.LongContext}
	}
	l, err := h.g.CliLaunch(kind, tabID, model, o)
	if err != nil {
		log.Printf("[harness] gateway cliLaunch failed: %v", err)
		return nil
	}
	if l == nil {
		return nil
	}
	return &ports.GatewayLaunch{Env: l.Env, Args: l.Args, Strip: l.Strip, ModelInConfig: l.ModelInConfig}
}

func (h harnessGateway) OfficialEnv(env *util.Obj) *util.Obj { return h.g.OfficialEnv(env) }

func (h harnessGateway) Models() []ports.GatewayModel {
	ms := h.g.CliModels()
	out := make([]ports.GatewayModel, 0, len(ms))
	for _, m := range ms {
		gm := ports.GatewayModel{Ref: util.JSString(m.Get("ref")), Provider: util.JSString(m.Get("provider")), Label: util.JSString(m.Get("label"))}
		if v, ok := m.Get("vision").(bool); ok {
			gm.Vision = &v
		}
		out = append(out, gm)
	}
	return out
}

func (h harnessGateway) ReleaseAgent(kind, tabID string) { h.g.ReleaseAgent(kind, tabID) }

// launchForTab：{env, generation, modelInConfig: Boolean(l.modelInConfig)} 或 null
func (h harnessGateway) LaunchForTab(kind, tabID, model string, effort *string, longContext *bool) *jsrt.Promise[*ports.GatewayTabLaunch] {
	return jsrt.Async(func() (*ports.GatewayTabLaunch, error) {
		e := ""
		if effort != nil {
			e = *effort
		}
		l, err := h.g.CliLaunchForTab(kind, tabID, model, e, longContext)
		if err != nil || l == nil {
			return nil, err
		}
		mic := l.ModelInConfig != nil && *l.ModelInConfig
		return &ports.GatewayTabLaunch{Env: l.Env, Generation: float64(l.Generation), ModelInConfig: &mic}, nil
	})
}

func (h harnessGateway) ReleaseTab(kind, tabID string, generation *float64) {
	g := -1
	if generation != nil {
		g = int(*generation)
	}
	h.g.ReleaseTab(kind, tabID, g)
}

// updateTab：models = {...store.clients[kind]?.models, main: model}，effort 有值才带
func (h harnessGateway) UpdateTab(kind, tabID, model string, effort *string) *jsrt.Promise[bool] {
	return jsrt.Async(func() (bool, error) {
		mo := util.NewObj()
		if cl, _ := h.g.Store.Snapshot().Get("clients").(*util.Obj); cl != nil {
			if c, _ := cl.Get(kind).(*util.Obj); c != nil {
				if m, _ := c.Get("models").(*util.Obj); m != nil {
					mo = m.Clone()
				}
			}
		}
		mo.Set("main", model)
		var cm config.ClientModels
		if err := json.Unmarshal([]byte(util.Stringify(mo)), &cm); err != nil {
			return false, err
		}
		in := gwstore.TabUpdateInput{Client: kind, TabID: tabID, Models: &cm}
		if effort != nil && *effort != "" {
			in.Effort = *effort
		}
		return h.g.Tabs().Update(in)
	})
}
