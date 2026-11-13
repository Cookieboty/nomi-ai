package askuser

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Register：ai.userQuestion.pending / ai.userQuestion.answer。
// 答复可能要写回 CLI 子进程，所以在 jsrt 锁里处理。
func Register(r *contract.Router, b *Broker) {
	if r == nil || b == nil {
		return
	}
	r.Call("ai.userQuestion.pending", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Pending(), nil
	})
	r.Call("ai.userQuestion.answer", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID      string   `json:"id"`
			Action  string   `json:"action"`
			Answers []Answer `json:"answers"`
			Details string   `json:"details"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return map[string]any{"ok": false}, nil
		}
		res := Result{Action: in.Action, Answers: in.Answers, Details: in.Details}
		ok := jsrt.Call(func() bool { return b.Answer(in.ID, res) })
		return map[string]any{"ok": ok}, nil
	})
}
