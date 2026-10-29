package codinghandlers

// coding.ts 中 agents.* 一节：AgentProgressService（进度监视）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Agents = AgentProgressService 的公开面（持 GIL 调用）
type Agents interface {
	State() *util.Obj
	ScanNow() (*util.Obj, error)
	SetSettings(patch any) (*util.Obj, error)
}

var _ Agents = (*agents.Service)(nil)

// RegisterAgents 挂上 agents.state / agents.scan / agents.setSettings（getter 返回 nil = UNAVAILABLE）
func RegisterAgents(r *contract.Router, get func() Agents) {
	ag := func() Agents { return need(get, "agents") }
	gil(r, "agents.state", func(in) any { return ag().State() })
	gil(r, "agents.scan", func(in) any {
		v, err := ag().ScanNow()
		throwIf(err)
		return v
	})
	gil(r, "agents.setSettings", func(a in) any {
		v, err := ag().SetSettings(a.o)
		throwIf(err)
		return v
	})
}
