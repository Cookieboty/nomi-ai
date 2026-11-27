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
	var budgetErr *cr.ErrBudget
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
	case errors.As(err, &budgetErr):
		code = "RUNTIME_REQUEST_TOO_LARGE"
	case errors.Is(err, cr.ErrBadEdit), errors.Is(err, cr.ErrPermission), errors.Is(err, convstore.ErrBadID), errors.Is(err, mainchat.ErrSwitchForbidden):
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
	if s.Thinking != "" {
		out["thinking"] = s.Thinking
	}
	if s.ThinkingActive {
		out["thinkingActive"] = true
	}
	if s.FailedRequest != nil {
		fr := map[string]any{"messageId": s.FailedRequest.MessageID, "turnId": s.FailedRequest.TurnID, "text": s.FailedRequest.Text}
		if len(s.FailedRequest.Images) > 0 {
			fr["images"] = s.FailedRequest.Images
		}
		out["failedRequest"] = fr
	}
	if s.Source != "" {
		out["source"] = s.Source
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
	if lc := r.ConfigFor(id, s.Backend).LongContext; lc != nil {
		out["longContext"] = *lc
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
	registry.SetStreamNotify(func(id string) {
		if view, err := RuntimeView(registry, id); err == nil {
			router.EmitTo("conversations.runtimeChanged", view, "chat")
		}
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
			if c.HasLocalLogin != nil {
				item["hasLocalLogin"] = *c.HasLocalLogin
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
				ID, Backend, MessageID, TurnID, Text, ApprovalID, Decision    string
				Source, Model, Effort, PermissionMode, AccountID, LongContext string
				Images                                                        []string
				ExpectedGeneration                                            *uint64
				BeforeGeneration                                              *uint64
				Confirm, ConfirmUnsafe, Retry, Allow                          bool
				Token                                                         struct {
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
				err = registry.AdoptWithOptions(in.ID, in.Backend, in.Confirm, mainchat.SwitchOptions{
					Source:         in.Source,
					Model:          in.Model,
					Effort:         in.Effort,
					PermissionMode: in.PermissionMode,
					AccountID:      in.AccountID,
					LongContext:    in.LongContext,
				})
			case "Select":
				err = registry.Select(in.ID, in.Backend)
			case "Switch":
				_, err = registry.Switch(ctx, in.ID, mainchat.SwitchOptions{
					Backend:            in.Backend,
					Source:             in.Source,
					Model:              in.Model,
					Effort:             in.Effort,
					PermissionMode:     in.PermissionMode,
					AccountID:          in.AccountID,
					LongContext:        in.LongContext,
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
	router.Call("conversations.runtimeRewind", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID                 string  `json:"id"`
			MessageID          string  `json:"messageId"`
			ExpectedGeneration *uint64 `json:"expectedGeneration"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		if err := registry.Rewind(in.ID, in.MessageID, in.ExpectedGeneration); err != nil {
			return nil, runtimeFail(err)
		}
		return RuntimeView(registry, in.ID)
	})
	router.Call("conversations.runtimeUpdateMeta", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID              string          `json:"id"`
			Name            *string         `json:"name"`
			AutoTitle       bool            `json:"autoTitle"`
			PinnedAt        json.RawMessage `json:"pinnedAt"`
			ArchivedAt      json.RawMessage `json:"archivedAt"`
			ReasoningEffort json.RawMessage `json:"reasoningEffort"`
			LongContext     json.RawMessage `json:"longContext"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, badInput(err)
		}
		parseOptTimestamp := func(field json.RawMessage) (set bool, val *int64, err error) {
			trimmed := bytes.TrimSpace(field)
			if len(trimmed) == 0 {
				return false, nil, nil
			}
			if string(trimmed) == "null" {
				return true, nil, nil
			}
			var v int64
			if err := json.Unmarshal(trimmed, &v); err != nil || v < 0 {
				return false, nil, errors.New("invalid timestamp")
			}
			return true, &v, nil
		}
		parseOptString := func(field json.RawMessage) (set bool, val *string, err error) {
			trimmed := bytes.TrimSpace(field)
			if len(trimmed) == 0 {
				return false, nil, nil
			}
			if string(trimmed) == "null" {
				return true, nil, nil
			}
			var s string
			if err := json.Unmarshal(trimmed, &s); err != nil || len(bytes.TrimSpace([]byte(s))) == 0 {
				return false, nil, errors.New("invalid string")
			}
			return true, &s, nil
		}
		parseOptLongContext := func(field json.RawMessage) (set bool, val *mainchat.ManagedLongContext, err error) {
			trimmed := bytes.TrimSpace(field)
			if len(trimmed) == 0 {
				return false, nil, nil
			}
			if string(trimmed) == "null" {
				return true, nil, nil
			}
			var obj struct {
				Model *string `json:"model"`
				On    *bool   `json:"on"`
			}
			if err := json.Unmarshal(trimmed, &obj); err != nil || obj.Model == nil || obj.On == nil || len(bytes.TrimSpace([]byte(*obj.Model))) == 0 {
				return false, nil, errors.New("invalid longContext")
			}
			return true, &mainchat.ManagedLongContext{Model: *obj.Model, On: *obj.On}, nil
		}
		pinSet, pinVal, err := parseOptTimestamp(in.PinnedAt)
		if err != nil {
			return nil, badInput(err)
		}
		archSet, archVal, err := parseOptTimestamp(in.ArchivedAt)
		if err != nil {
			return nil, badInput(err)
		}
		effortSet, effortVal, err := parseOptString(in.ReasoningEffort)
		if err != nil {
			return nil, badInput(err)
		}
		longSet, longVal, err := parseOptLongContext(in.LongContext)
		if err != nil {
			return nil, badInput(err)
		}
		err = registry.UpdateMeta(in.ID, mainchat.ManagedMetaPatch{
			Name:               in.Name,
			AutoTitle:          in.AutoTitle,
			PinnedAtSet:        pinSet,
			PinnedAt:           pinVal,
			ArchivedAtSet:      archSet,
			ArchivedAt:         archVal,
			ReasoningEffortSet: effortSet,
			ReasoningEffort:    effortVal,
			LongContextSet:     longSet,
			LongContext:        longVal,
		})
		if err != nil {
			return nil, runtimeFail(err)
		}
		return nil, nil
	})
	return registry
}
