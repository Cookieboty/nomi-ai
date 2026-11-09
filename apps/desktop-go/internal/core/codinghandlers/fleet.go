package codinghandlers

// fleet.*：Agent 看板（core/fleet）。不进 GIL：服务自己在 GIL 外读任务与进程表，只在读标签时进 GIL。

import (
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/fleet"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Fleet = fleet.Service 的公开面
type Fleet interface {
	State() fleet.State
	Archive(id string) fleet.State
	CloseIdle(pid float64, backend string) (fleet.State, error)
	Pause(id string) (fleet.State, error)
	Resume(id string) (fleet.State, error)
	SetAutoPause(on bool) fleet.State
	SetPolicy(mode string) fleet.State
}

var _ Fleet = (*fleet.Service)(nil)

// RegisterFleet 挂上 fleet.state / archive / closeIdle / pause / resume / setAutoPause / setPolicy（getter 返回 nil = UNAVAILABLE）
func RegisterFleet(r *contract.Router, get func() Fleet) {
	fl := func() Fleet { return need(get, "fleet") }
	plain(r, "fleet.state", func(in) any { return fl().State() })
	plain(r, "fleet.archive", func(a in) any { return fl().Archive(util.Str(a.o.Get("id"))) })
	plain(r, "fleet.closeIdle", func(a in) any {
		pid, _ := a.o.Get("pid").(float64)
		st, err := fl().CloseIdle(pid, util.Str(a.o.Get("backend")))
		if errors.Is(err, fleet.ErrNotIdle) {
			panic(&contract.Error{Code: "FLEET_NOT_IDLE", Message: "process is no longer an idle coding agent outside Nomi"})
		}
		if errors.Is(err, fleet.ErrCloseDenied) {
			panic(&contract.Error{Code: "FLEET_CLOSE_DENIED", Message: err.Error()})
		}
		if errors.Is(err, fleet.ErrCloseUnverified) {
			panic(&contract.Error{Code: "FLEET_CLOSE_UNVERIFIED", Message: "could not read the process table to confirm it is still idle"})
		}
		if errors.Is(err, fleet.ErrCloseFailed) {
			panic(&contract.Error{Code: "FLEET_CLOSE_FAILED", Message: err.Error()})
		}
		throwIf(err)
		return st
	})
	notPausable := func(st fleet.State, err error) any {
		if errors.Is(err, fleet.ErrNotPausable) {
			panic(&contract.Error{Code: "FLEET_NOT_PAUSABLE", Message: "agent cannot be paused or resumed right now"})
		}
		throwIf(err)
		return st
	}
	plain(r, "fleet.pause", func(a in) any { return notPausable(fl().Pause(util.Str(a.o.Get("id")))) })
	plain(r, "fleet.resume", func(a in) any { return notPausable(fl().Resume(util.Str(a.o.Get("id")))) })
	plain(r, "fleet.setAutoPause", func(a in) any { return fl().SetAutoPause(a.o.Get("enabled") == true) })
	plain(r, "fleet.setPolicy", func(a in) any { return fl().SetPolicy(util.Str(a.o.Get("mode"))) })
}
