package codinghandlers

// fleet.*：Agent 看板（core/fleet）。不进 GIL：服务自己在 GIL 外读任务与进程表，只在读标签时进 GIL。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/fleet"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Fleet = fleet.Service 的公开面
type Fleet interface {
	State() fleet.State
	Archive(id string) fleet.State
}

var _ Fleet = (*fleet.Service)(nil)

// RegisterFleet 挂上 fleet.state / fleet.archive（getter 返回 nil = UNAVAILABLE）
func RegisterFleet(r *contract.Router, get func() Fleet) {
	fl := func() Fleet { return need(get, "fleet") }
	plain(r, "fleet.state", func(in) any { return fl().State() })
	plain(r, "fleet.archive", func(a in) any { return fl().Archive(util.Str(a.o.Get("id"))) })
}
