package shellhandlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
)

func runtimeFail(err error) error {
	if err == nil {
		return nil
	}
	code := "RUNTIME_FAILED"
	switch {
	case errors.Is(err, mainchat.ErrUnavailable), errors.Is(err, convstore.ErrDurabilityUnsupported):
		code = "RUNTIME_UNAVAILABLE"
	case errors.Is(err, convstore.ErrNotFound):
		code = "CONVERSATION_NOT_FOUND"
	case errors.Is(err, cr.ErrBusy):
		code = "RUNTIME_BUSY"
	case errors.Is(err, cr.ErrUnresolved):
		code = "RUNTIME_UNRESOLVED"
	case errors.Is(err, cr.ErrStaleEvent), errors.Is(err, cr.ErrStaleBinding):
		code = "RUNTIME_STALE"
	case errors.Is(err, cr.ErrBadEdit), errors.Is(err, cr.ErrPermission), errors.Is(err, convstore.ErrBadID):
		code = "BAD_INPUT"
	}
	return &contract.Error{Code: code, Message: err.Error()}
}
func runtimeToken(t cr.AttemptToken) map[string]any {
	return map[string]any{"conversationId": t.ConversationID, "attemptId": t.AttemptID, "generation": t.Generation}
}
func RuntimeView(r *mainchat.Registry, id string) (any, error) {
	s, err := r.State(id)
	if err != nil {
		return nil, runtimeFail(err)
	}
	approvals := s.Approvals
	if approvals == nil {
		approvals = []string{}
	}
	modes := s.Capabilities.PermissionModes
	if modes == nil {
		modes = []string{}
	}
	degraded := s.Capabilities.Degraded
	if degraded == nil {
		degraded = []string{}
	}
	recovery := string(s.Recovery.Kind)
	if recovery == "" {
		recovery = "none"
	}
	caps := map[string]any{
		"resume":          s.Capabilities.Resume,
		"cancel":          s.Capabilities.Cancel,
		"approval":        s.Capabilities.Approval,
		"attachments":     s.Capabilities.Attachments,
		"permissionModes": modes,
		"degraded":        degraded,
	}
	if s.Capabilities.Bridges != nil {
		caps["bridges"] = s.Capabilities.Bridges
	}
	out := map[string]any{"id": id, "backend": s.Backend, "generation": s.Generation, "phase": s.Phase, "queued": s.Queued, "partial": s.Partial, "detail": s.Detail, "approvals": approvals, "recovery": recovery,
		"capabilities": caps}
	if len(s.ApprovalDetails) > 0 {
		out["approvalDetails"] = s.ApprovalDetails
	}
	if len(s.Trace) > 0 {
		out["trace"] = s.Trace
	}
	if s.FailedRequest != nil {
		fr := map[string]any{"messageId": s.FailedRequest.MessageID, "turnId": s.FailedRequest.TurnID, "text": s.FailedRequest.Text}
		if len(s.FailedRequest.Images) > 0 {
			fr["images"] = s.FailedRequest.Images
		}
		out["failedRequest"] = fr
	}
	if s.Model != "" {
		out["model"] = s.Model
	}
	if s.AccountID != "" {
		out["accountId"] = s.AccountID
	}
	if s.PermissionMode != "" {
		out["permissionMode"] = s.PermissionMode
	}
	if s.Effort != "" {
		out["effort"] = s.Effort
	}
	if s.PendingSwitch != nil {
		ps := map[string]any{
			"phase":       s.PendingSwitch.Phase,
			"fromBackend": s.PendingSwitch.From.Identity.DriverID,
			"toBackend":   s.PendingSwitch.To.Identity.DriverID,
		}
		if s.PendingSwitch.ExpectedStrategy != "" {
			ps["expectedStrategy"] = s.PendingSwitch.ExpectedStrategy
		}
		if s.PendingSwitch.PlannedEntries > 0 {
			ps["plannedEntries"] = s.PendingSwitch.PlannedEntries
		}
		if s.PendingSwitch.OmittedEntries > 0 {
			ps["omittedEntries"] = s.PendingSwitch.OmittedEntries
		}
		if s.PendingSwitch.Reason != "" {
			ps["reason"] = s.PendingSwitch.Reason
		}
		out["pendingSwitch"] = ps
	}
	if s.LastSwitch != nil {
		out["lastSwitch"] = s.LastSwitch
	}
	if s.Token.AttemptID != "" {
		out["token"] = runtimeToken(s.Token)
	}
	return out, nil
}
func InstallConversationRuntime(router *contract.Router, s *convstore.Store) *mainchat.Registry {
	var registry *mainchat.Registry
	registry = mainchat.New(s, func(id string) {
		if view, err := RuntimeView(registry, id); err == nil {
			router.EmitTo("conversations.runtimeChanged", view, "chat")
		}
		router.EmitTo("conversations.changed", map[string]any{"source": "runtime", "ids": []string{id}, "index": true}, "chat")
	})
	router.Call("conversations.runtimeCapabilities", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct{ ID string }
		if len(bytes.TrimSpace(raw)) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, badInput(err)
			}
		}
		detail := "Experimental explicit opt-in; API mode supports Nomi tools and approvals with a configured provider; installed CLI backends have unverified login and declared capability limits"
		if !convstore.ManagedSupported() {
			detail = "Managed runtime persistence is unsupported on this platform; existing API conversations remain available"
		}
		choices := registry.Choices(in.ID)
		if choices == nil {
			choices = []mainchat.RuntimeChoice{}
		}
		out := []map[string]any{}
		for _, c := range choices {
			degraded := c.Degraded
			if degraded == nil {
				degraded = []string{}
			}
			item := map[string]any{"id": c.ID, "available": c.Available, "status": c.Status, "detail": c.Detail, "login": c.Login, "requiresProject": c.RequiresProject, "degraded": degraded}
			if len(c.Accounts) > 0 {
				item["accounts"] = c.Accounts
			}
			if len(c.Models) > 0 {
				item["models"] = c.Models
			}
			if len(c.PermissionModes) > 0 {
				item["permissionModes"] = c.PermissionModes
			}
			if c.Bridges != nil {
				item["bridges"] = c.Bridges
			}
			out = append(out, item)
		}
		return map[string]any{"supported": convstore.ManagedSupported(), "backends": registry.Available(), "detail": detail, "choices": out}, nil
	})
	for _, name := range []string{"State", "Adopt", "Select", "Switch", "Send", "Cancel", "Approve", "Edit", "Release", "Resolve"} {
		op := name
		router.Call("conversations.runtime"+op, func(ctx context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			var in struct {
				ID, Backend, MessageID, TurnID, Text, ApprovalID, Decision string
				Model, Effort, PermissionMode, AccountID                   string
				Images                                                     []string
				ExpectedGeneration                                         *uint64
				BeforeGeneration                                           *uint64
				Confirm, ConfirmUnsafe, Retry, Allow                       bool
				Token                                                      struct {
					ConversationID, AttemptID string
					Generation                uint64
				}
			}
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, badInput(err)
			}
			var err error
			switch op {
			case "Adopt":
				err = registry.Adopt(in.ID, in.Backend, in.Confirm)
			case "Select":
				err = registry.Select(in.ID, in.Backend)
			case "Switch":
				_, err = registry.Switch(ctx, in.ID, mainchat.SwitchOptions{
					Backend:            in.Backend,
					Model:              in.Model,
					Effort:             in.Effort,
					PermissionMode:     in.PermissionMode,
					AccountID:          in.AccountID,
					Confirm:            in.Confirm,
					ConfirmUnsafe:      in.ConfirmUnsafe,
					ExpectedGeneration: in.ExpectedGeneration,
				})
			case "Send":
				var expected uint64
				if in.ExpectedGeneration != nil {
					expected = *in.ExpectedGeneration
				}
				var token cr.AttemptToken
				token, err = registry.Send(ctx, in.ID, cr.Request{MessageID: in.MessageID, TurnID: in.TurnID, Text: in.Text, Images: in.Images, Retry: in.Retry}, expected)
				if err != nil {
					return nil, runtimeFail(err)
				}
				return runtimeToken(token), nil
			case "Cancel":
				if in.BeforeGeneration != nil {
					if in.TurnID == "" {
						return nil, badInput(errors.New("turnId required"))
					}
					_, err = registry.CancelTurn(ctx, in.ID, in.TurnID, *in.BeforeGeneration)
				} else {
					_, err = registry.Cancel(ctx, in.ID)
				}
			case "Approve":
				err = registry.Approve(ctx, in.ID, cr.AttemptToken{ConversationID: in.Token.ConversationID, AttemptID: in.Token.AttemptID, Generation: in.Token.Generation}, in.ApprovalID, in.Allow)
			case "Edit":
				err = registry.Edit(in.ID, in.MessageID, in.Text)
			case "Release":
				return nil, registry.Release(in.ID)
			case "Resolve":
				if in.ExpectedGeneration == nil {
					return nil, badInput(errors.New("expectedGeneration required"))
				}
				err = registry.Resolve(in.ID, in.Decision, in.Confirm, in.ExpectedGeneration)
			}
			if err != nil {
				return nil, runtimeFail(err)
			}
			return RuntimeView(registry, in.ID)
		})
	}
	return registry
}
