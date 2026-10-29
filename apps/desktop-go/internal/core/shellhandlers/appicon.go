package shellhandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/appicon"
)

// InstallAppIcon：shell.ts 的 appIcon.*（宿主片段，= host-electron/src/host/contract/index.ts）
func InstallAppIcon(r *contract.Router, svc *appicon.Service) {
	r.Call("appIcon.get", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return svc.Get(), nil
	})
	r.Call("appIcon.set", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Variant *string `json:"variant"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		if in.Variant == nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}
		}
		return svc.Set(*in.Variant), nil
	})
}
