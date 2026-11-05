package shellhandlers

// providerLink.*：契约 shell 域的 providerLink 部分
// （第三方供应商链接，docs/integrations/provider-link.md）。providerLink.changed 由服务的 Publish 发出。

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/providerlink"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ProviderLinkProcedures：本文件注册的过程
var ProviderLinkProcedures = []string{
	"providerLink.list", "providerLink.accept", "providerLink.reject", "providerLink.connect",
}

// linkErr：链接 / 授权失败 → 契约错误 PROVIDER_LINK_FAILED（message 是错误码，视图翻译）
func linkErr(err error) error {
	var e *providerlink.Error
	if errors.As(err, &e) {
		return &contract.Error{Code: "PROVIDER_LINK_FAILED", Message: e.Code}
	}
	return err
}

// InstallProviderLink：svc 为 nil 时 UNAVAILABLE
func InstallProviderLink(r *contract.Router, svc *providerlink.Service) {
	call := func(name string, fn func(s *providerlink.Service, in *u.Obj) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			if svc == nil {
				return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'providerLink' is not available"}
			}
			in, err := parseObj(raw)
			if err != nil {
				return nil, err
			}
			return fn(svc, in)
		})
	}
	str := func(in *u.Obj, k string) string { s, _ := in.Get(k).(string); return s }
	call("providerLink.list", func(s *providerlink.Service, _ *u.Obj) (any, error) { return s.List(), nil })
	call("providerLink.accept", func(s *providerlink.Service, in *u.Obj) (any, error) {
		res, err := s.Accept(str(in, "id"))
		if err != nil {
			return nil, linkErr(err)
		}
		return res, nil
	})
	call("providerLink.reject", func(s *providerlink.Service, in *u.Obj) (any, error) {
		s.Reject(str(in, "id"))
		return nil, nil
	})
	call("providerLink.connect", func(s *providerlink.Service, in *u.Obj) (any, error) {
		res, err := s.Connect(str(in, "issuer"))
		if err != nil {
			return nil, linkErr(err)
		}
		return res, nil
	})
}
