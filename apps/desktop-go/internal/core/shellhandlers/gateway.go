package shellhandlers

// gateway.* —— packages/core/src/contract/shell.ts 的 gateway() 部分（GatewayService）。
// gateway.detect = probe/detect.ts 移植（gwstore.Service.Detect）；gateway.terminal* = TerminalCommands（InstallTerminal）。

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/terminal"
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
	"gateway.state", "gateway.nomiContext", "gateway.detect", "gateway.retry", "gateway.upsertProvider", "gateway.removeProvider",
	"gateway.setAssignment", "gateway.setOptions", "gateway.resetToken", "gateway.clearLearned",
	"gateway.confirmPrivateHost", "gateway.privacyPreview", "gateway.privacyLog", "gateway.privacyClearLog",
	"gateway.privacyAddAllow", "gateway.privacyRemoveAllow", "gateway.privacyAddSecret",
	"gateway.privacyRemoveSecret", "gateway.privacySetAction",
	"gateway.terminalState", "gateway.terminalSet",
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
	// 网关服务还没起来时当作没配模型（视图按默认预算），同 shell.ts
	r.Call("gateway.nomiContext", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		in, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		if svc == nil {
			return nil, nil
		}
		role, _ := in.Get("role").(string)
		if role == "" {
			role = "chat"
		}
		if o := svc.NomiContext(role); o != nil {
			return o, nil
		}
		return nil, nil
	})
	call("gateway.detect", func(g *gwstore.Service, in *u.Obj) (any, error) { return g.Detect(in) })
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

// InstallTerminal：gateway.terminalState / gateway.terminalSet（= need(s.terminal, 'terminal')）
func InstallTerminal(r *contract.Router, t *terminal.Commands) {
	call := func(name string, fn func(in *u.Obj) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			if t == nil {
				return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'terminal' is not available"}
			}
			in, err := parseObj(raw)
			if err != nil {
				return nil, err
			}
			return fn(in)
		})
	}
	call("gateway.terminalState", func(_ *u.Obj) (any, error) { return t.State(), nil })
	call("gateway.terminalSet", func(in *u.Obj) (any, error) {
		en, _ := in.Get("enabled").(bool)
		var add *bool
		if b, ok := in.Get("addToPath").(bool); ok {
			add = &b
		}
		return t.Set(en, add)
	})
}
