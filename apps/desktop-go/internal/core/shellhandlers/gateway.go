package shellhandlers

// gateway.* —— packages/core/src/contract/shell.ts 的 gateway() 部分（GatewayService）。
// gateway.detect 需要 probe/detect.ts 的移植：svc 未注入 Detect 时仍走 UNAVAILABLE 桩（D-B5-GW-1）。

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func parseObj(raw json.RawMessage) (*u.Obj, error) {
	if len(raw) == 0 {
		return u.NewObj(), nil
	}
	v, err := u.Parse(raw)
	if err != nil {
		return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
	}
	o, _ := v.(*u.Obj)
	if o == nil {
		o = u.NewObj()
	}
	return o, nil
}

// GatewayProcedures：本文件注册的过程（测试 / 文档用）
var GatewayProcedures = []string{
	"gateway.state", "gateway.retry", "gateway.upsertProvider", "gateway.removeProvider",
	"gateway.setAssignment", "gateway.setOptions", "gateway.resetToken", "gateway.clearLearned",
	"gateway.confirmPrivateHost", "gateway.privacyPreview", "gateway.privacyLog", "gateway.privacyClearLog",
	"gateway.privacyAddAllow", "gateway.privacyRemoveAllow", "gateway.privacyAddSecret",
	"gateway.privacyRemoveSecret", "gateway.privacySetAction",
}

// InstallGateway：注册 gateway.*（gateway.changed 由服务的 Broadcast 发出）。svc 为 nil 时 UNAVAILABLE。
func InstallGateway(r *contract.Router, svc *gwstore.Service) {
	call := func(name string, fn func(g *gwstore.Service, in *u.Obj) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			if svc == nil {
				return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'gateway' is not available"}
			}
			in, err := parseObj(raw)
			if err != nil {
				return nil, err
			}
			return fn(svc, in)
		})
	}
	str := func(in *u.Obj, k string) string { s, _ := in.Get(k).(string); return s }
	call("gateway.state", func(g *gwstore.Service, _ *u.Obj) (any, error) { return g.State(), nil })
	call("gateway.retry", func(g *gwstore.Service, _ *u.Obj) (any, error) { g.Retry(); return nil, nil })
	call("gateway.upsertProvider", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.UpsertProvider(in) })
	call("gateway.removeProvider", func(g *gwstore.Service, in *u.Obj) (any, error) {
		return nil, g.RemoveProvider(str(in, "id"))
	})
	call("gateway.setAssignment", func(g *gwstore.Service, in *u.Obj) (any, error) {
		p, _ := in.Get("patch").(*u.Obj)
		return nil, g.SetAssignmentFor(in.Get("client"), p)
	})
	call("gateway.setOptions", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.SetOptions(in) })
	call("gateway.resetToken", func(g *gwstore.Service, in *u.Obj) (any, error) {
		return nil, g.ResetTokenFor(in.Get("client"))
	})
	call("gateway.clearLearned", func(g *gwstore.Service, in *u.Obj) (any, error) {
		return nil, g.ClearLearned(str(in, "providerId"))
	})
	call("gateway.confirmPrivateHost", func(g *gwstore.Service, in *u.Obj) (any, error) {
		return nil, g.ConfirmPrivateHost(str(in, "hostPort"))
	})
	call("gateway.privacyPreview", func(g *gwstore.Service, in *u.Obj) (any, error) {
		return g.PreviewPrivacy(in.Get("text")), nil
	})
	call("gateway.privacyLog", func(g *gwstore.Service, _ *u.Obj) (any, error) { return g.PrivacyLogEntries(), nil })
	call("gateway.privacyClearLog", func(g *gwstore.Service, _ *u.Obj) (any, error) { g.ClearPrivacyLog(); return nil, nil })
	call("gateway.privacyAddAllow", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.AddPrivacyAllow(in) })
	call("gateway.privacyRemoveAllow", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.RemovePrivacyAllow(in.Get("tag")) })
	call("gateway.privacyAddSecret", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.AddPrivacySecret(in) })
	call("gateway.privacyRemoveSecret", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.RemovePrivacySecret(in.Get("id")) })
	call("gateway.privacySetAction", func(g *gwstore.Service, in *u.Obj) (any, error) {
		return g.SetPrivacyAction(in.Get("kind"), in.Get("action"))
	})
}
