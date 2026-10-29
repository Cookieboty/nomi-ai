package pendingevents

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Register 接上事件总线的 pending.offer，并挂 nav.takePending（contract/media.ts）：
// 取走 nav 组留着的事件；是对话导航事件时返回 { event }，否则 null。
func Register(r *contract.Router, p *Pending) {
	r.Pending = p.Offer
	r.Call("nav.takePending", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return TakeNav(p), nil
	})
}

// TakeNav = nav.takePending 的处理函数体
func TakeNav(p *Pending) any {
	e := p.Take("nav")
	if e != nil && IsChatNavEvent(e.Event) {
		return util.NewObj("event", e.Event)
	}
	return nil
}
