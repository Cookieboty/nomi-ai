package shellhandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/diagnostics"
)

func unavailable(svc string) error {
	return &contract.Error{Code: "UNAVAILABLE", Message: "Service '" + svc + "' is not available"}
}

func badInput(err error) error { return &contract.Error{Code: "BAD_INPUT", Message: err.Error()} }

// InstallDiagnostics：shell.ts 的 diagnostics.*（core/contract/shell.ts）
func InstallDiagnostics(r *contract.Router, svc func() *diagnostics.Service) {
	need := func() (*diagnostics.Service, error) {
		if s := svc(); s != nil {
			return s, nil
		}
		return nil, unavailable("diagnostics")
	}
	r.Call("diagnostics.get", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		s, err := need()
		if err != nil {
			return nil, err
		}
		return s.View(), nil
	})
	r.Call("diagnostics.set", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			On bool `json:"on"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		s, err := need()
		if err != nil {
			return nil, err
		}
		return s.Set(in.On), nil
	})
	r.Call("diagnostics.openFolder", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		s, err := need()
		if err != nil {
			return nil, err
		}
		return s.OpenLogFolder()
	})
	r.Call("diagnostics.export", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		s, err := need()
		if err != nil {
			return nil, err
		}
		return s.ExportBundle(), nil
	})
}
