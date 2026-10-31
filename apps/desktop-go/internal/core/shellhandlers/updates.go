package shellhandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/updates"
)

// InstallUpdates：shell.ts 的 updates.*（updates.changed 由服务自己发布）
func InstallUpdates(r *contract.Router, svc func() *updates.Service, notes *updates.Notes) {
	get := func() (*updates.Service, error) {
		if s := svc(); s != nil {
			return s, nil
		}
		return nil, unavailable("updates")
	}
	q := func(name string, f func(*updates.Service) updates.State) {
		r.Call(name, func(context.Context, contract.Caller, json.RawMessage) (any, error) {
			s, err := get()
			if err != nil {
				return nil, err
			}
			return f(s), nil
		})
	}
	q("updates.get", (*updates.Service).GetState)
	q("updates.check", (*updates.Service).Check)
	q("updates.download", (*updates.Service).Download)
	q("updates.install", (*updates.Service).Install)
	r.Call("updates.releaseNotes", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Version *string `json:"version"`
		}
		if len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &in); err != nil || (in.Version != nil && len(*in.Version) > 64) {
				return nil, &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}
			}
		}
		v := ""
		if in.Version != nil {
			v = *in.Version
		}
		if notes == nil {
			return updates.NotesResult{Version: v}, nil
		}
		return notes.Get(v), nil
	})
	r.Call("updates.setAutoCheck", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in map[string]json.RawMessage
		if err := json.Unmarshal(raw, &in); err != nil || in == nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}
		}
		v, ok := in["on"]
		if !ok {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}
		}
		var on bool
		if json.Unmarshal(v, &on) != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}
		}
		s, err := get()
		if err != nil {
			return nil, err
		}
		s.SetAutoCheck(on)
		return s.GetState(), nil
	})
}
