// Package procs 把生成的契约过程表装到 Router 上：已实现的过程由各域包注册，
// 其余过程统一注册为返回 UNAVAILABLE 的桩，保证渲染进程调用任何契约过程都能拿到明确的错误。
package procs

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract/gen"
)

// ErrNotImplemented 的 code 用契约 APP_ERRORS 里的 UNAVAILABLE（契约没有 NOT_IMPLEMENTED）
func ErrNotImplemented(name string) error {
	return &contract.Error{Code: "UNAVAILABLE", Message: name + ": not implemented in the Go host yet"}
}

// Install：给 surfaces 上限制，并为未注册的过程补桩。返回补桩的过程数。
func Install(r *contract.Router) int {
	have := r.Registered()
	n := 0
	for _, p := range gen.Procedures {
		r.Declare(p.Name, p.Kind, p.Dangerous)
		if len(p.Surfaces) > 0 {
			r.Restrict(p.Name, p.Surfaces)
		}
		if _, ok := have[p.Name]; ok {
			continue
		}
		name := p.Name
		n++
		if p.Kind == "stream" {
			r.Stream(name, func(context.Context, contract.Caller, json.RawMessage, func(any) error) (any, error) {
				return nil, ErrNotImplemented(name)
			})
		} else {
			r.Call(name, func(context.Context, contract.Caller, json.RawMessage) (any, error) {
				return nil, ErrNotImplemented(name)
			})
		}
	}
	return n
}
