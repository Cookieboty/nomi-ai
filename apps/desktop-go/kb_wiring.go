package main

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mediahandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 知识库的云端供应商：createCore 的 listProviders / credentials（aiRuntime 走网关）与 chatProvider（desktop.providerFor('chat')）

func kbProviders(g func() mediahandlers.GatewayLike) func() []knowledge.Provider {
	list := mediahandlers.GatewayProviders(g)
	return func() []knowledge.Provider {
		out := []knowledge.Provider{}
		for _, p := range list() {
			out = append(out, knowledge.Provider{ID: p.ID, Name: p.Name, BaseURL: p.BaseURL})
		}
		return out
	}
}

func kbCredentials(g func() mediahandlers.GatewayLike) func(string) *knowledge.Credentials {
	creds := mediahandlers.GatewayCredentials(g)
	return func(id string) *knowledge.Credentials {
		c := creds(id)
		if c == nil {
			return nil
		}
		return &knowledge.Credentials{Provider: knowledge.Provider{ID: c.ID, Name: c.Name, BaseURL: c.BaseURL}, APIKey: c.APIKey}
	}
}

func kbChatProvider(s *desktop.Service) func() *knowledge.ChatProvider {
	return func() *knowledge.ChatProvider {
		p := s.ProviderFor("chat")
		if p == nil {
			return nil
		}
		return &knowledge.ChatProvider{ID: p.ID, Name: p.Name, Local: p.Local}
	}
}

// aiMemory：记忆服务同步到 AI 客户端的 memory（同 Node services.aiRuntime.client.memory）；门面建好前为 nil
func aiMemory(f **aifacade.Facade) func() memory.Facade {
	return func() memory.Facade {
		if *f == nil {
			return nil
		}
		return memoryFacade{*f}
	}
}

type memoryFacade struct{ f *aifacade.Facade }

// ordered：按 Node 对象字面量的键序建对象（写进门面的事实 / 摘要与 Node 一致）
func ordered(m map[string]any, keys ...string) *u.Obj {
	o := u.NewObj()
	for _, k := range keys {
		if v, ok := m[k]; ok {
			o.Set(k, v)
		}
	}
	return o
}

func (m memoryFacade) PutFact(x map[string]any) {
	m.f.PutFact(ordered(x, "id", "kind", "text", "source", "at"))
}

func (m memoryFacade) DeleteFact(id string) bool { return m.f.DeleteFact(id) }

func (m memoryFacade) PutSummary(x map[string]any) {
	m.f.PutSummary(ordered(x, "sessionId", "summary", "updatedAt", "stepCount"))
}

func (m memoryFacade) Profile() any { return m.f.Profile().Get() }

func (m memoryFacade) ResetProfile(context.Context) error {
	_, err := m.f.Profile().Reset()
	return err
}
