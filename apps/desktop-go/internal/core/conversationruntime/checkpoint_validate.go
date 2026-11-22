package conversationruntime

import (
	"bytes"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

func ValidateCheckpoint(c Checkpoint) error {
	bad := func(why string) error { return fmt.Errorf("%w: invalid checkpoint: %s", ErrBadEdit, why) }
	if c.Version != CheckpointVersion || c.ConversationID == "" {
		return bad("version/conversation")
	}
	latest := map[string]Entry{}
	orders := map[int64]string{}
	revisions := map[string]map[int]bool{}
	for _, e := range c.History {
		if e.ID == "" || !utf8OK(e.ID) || !utf8OK(e.TurnID) || e.Order < 1 || e.Revision < 1 || !utf8OK(e.Text) || (e.Role != "user" && e.Role != "assistant") {
			return bad("entry")
		}
		if id, ok := orders[e.Order]; ok && id != e.ID {
			return bad("order collision")
		}
		orders[e.Order] = e.ID
		if len(e.Raw) > 0 && (!json.Valid(e.Raw) || !utf8.Valid(e.Raw) || bytes.TrimSpace(e.Raw)[0] != '{') {
			return bad("raw payload")
		}
		old, ok := latest[e.ID]
		if !ok && e.Order != int64(len(latest)+1) {
			return bad("initial order sequence")
		}
		if (!ok && e.Revision != 1) || (ok && (e.Revision != old.Revision+1 || e.Order != old.Order || e.TurnID != old.TurnID || e.Role != old.Role)) {
			return bad("revision sequence")
		}
		latest[e.ID] = e
		if revisions[e.ID] == nil {
			revisions[e.ID] = map[int]bool{}
		}
		revisions[e.ID][e.Revision] = true
	}
	bindings := map[string]Binding{}
	for _, b := range c.Bindings {
		if b.ID == "" || b.CompatKey == "" {
			return bad("binding identity")
		}
		if _, ok := bindings[b.ID]; ok {
			return bad("duplicate binding")
		}
		switch b.Status {
		case StatusLive, StatusIdle, StatusUnknown, StatusStale, StatusUnverified:
		default:
			return bad("binding status")
		}
		bindings[b.ID] = b
		if len(b.Coverage.Delivered)+len(b.Coverage.Partial) > 0 && b.NativeSessionID == "" {
			return bad("coverage without native identity")
		}
		for id, rev := range b.InvalidatedByRev {
			if !revisions[id][rev] || rev < 2 {
				return bad("invalidation boundary")
			}
		}
		for id, d := range b.Coverage.Delivered {
			e, ok := latest[id]
			if !ok || e.Tombstone || e.Revision != d.Rev || TextDigest(e.Text) != d.Digest || len(e.Attachments) > 0 {
				return bad("delivered revision/digest")
			}
		}
		for id, p := range b.Coverage.Partial {
			if _, ok := b.Coverage.Delivered[id]; ok {
				return bad("partial and full overlap")
			}
			e, ok := latest[id]
			if !ok || e.Tombstone || e.Revision != p.Rev || TextDigest(e.Text) != p.Digest || ValidateRanges(p.Ranges, e.Text) != nil || len(p.Ranges) == 0 || len(e.Attachments) > 0 {
				return bad("partial revision/range")
			}
		}
	}
	for key, id := range c.Preferred {
		b, ok := bindings[id]
		if !ok || b.CompatKey != key {
			return bad("preferred binding")
		}
	}
	for id, rev := range c.Completed {
		if !revisions[id][rev] || latest[id].Role != "user" {
			return bad("completed revision")
		}
	}

	if err := validateTargetState(c.Selected); err != nil {
		return bad("selected target: " + err.Error())
	}
	if sw := c.PendingSwitch; sw != nil {
		switch sw.Phase {
		case "saved-source", "preparing-target", "recovering-target", "handoff", "committing":
		default:
			return bad("switch phase")
		}
		if sw.From.Identity.DriverID == "" || sw.To.Identity.DriverID == "" || validateTargetState(sw.From) != nil || validateTargetState(sw.To) != nil {
			return bad("switch target")
		}
	}
	queued := map[string]bool{}
	for _, r := range c.Queue {
		if r.MessageID == "" || r.TurnID == "" || !utf8OK(r.Text) || len(r.Attachments) > 0 || queued[r.MessageID] {
			return bad("queued request")
		}
		queued[r.MessageID] = true
	}
	for id, yes := range c.Attempted {
		if !yes || latest[id].Role != "user" {
			return bad("attempted request")
		}
	}
	for id, receipt := range c.Receipts {
		var r struct {
			Kind            DeliveryKind
			NativeSessionID string
			Parts           []DeliveredPart
		}
		if id == "" || json.Unmarshal([]byte(receipt), &r) != nil || r.NativeSessionID == "" || (r.Kind != DeliveredFull && r.Kind != DeliveredPartial) {
			return bad("receipt")
		}
	}
	if a := c.Active; a != nil {
		switch a.Phase {
		case PhasePreparing, PhaseRunning, PhaseCompleted, PhaseFailed, PhaseCanceling, PhaseCanceled, PhaseUncertain:
		default:
			return bad("attempt phase")
		}
		if a.Token.ConversationID != c.ConversationID || a.Token.Generation > c.Generation || a.Token.AttemptID == "" {
			return bad("attempt token")
		}
		if a.Request.MessageID != "" {
			e, ok := latest[a.Request.MessageID]
			if !ok || e.Role != "user" {
				return bad("attempt request")
			}
		}
		if a.BindingID != "" {
			if _, ok := bindings[a.BindingID]; !ok {
				return bad("attempt binding")
			}
		}

		if a.Request.MessageID == "" && a.Phase != PhaseUncertain {
			return bad("missing active request")
		}
		if len(a.Request.Attachments) > 0 || !utf8OK(a.Request.Text) {
			return bad("active request content")
		}
		if a.Plan.ID != "" {
			if a.Plan.BindingID != a.BindingID || a.Plan.BindingKey != bindings[a.BindingID].CompatKey || jsonLen(a.Plan.Payload) != a.Plan.PayloadBytes || jsonLen(a.Plan.RequestBody) != a.Plan.RequestBytes {
				return bad("active plan")
			}
			if !revisions[a.Request.MessageID][a.Plan.TargetRev] || a.Plan.RequestBody != a.Request.Text || a.Plan.TargetDigest != TextDigest(a.Request.Text) {
				return bad("plan request revision")
			}
		} else if a.Delivered {
			return bad("delivered without plan")
		}
		if a.Delivered && c.Receipts[a.Plan.ID] == "" {
			return bad("delivered without receipt")
		}
		if !utf8OK(a.Draft) {
			return bad("draft UTF-8")
		}
	}
	return nil
}

func validateTargetState(t TargetState) error {
	if t.Identity.DriverID == "" {
		// Initial unselected conversations have exactly the empty target.
		if t.Identity != (NativeIdentity{}) || t.Env != (CompatibilityKey{}) || t.Capabilities.Budget != 0 || len(t.Capabilities.PermissionModes) != 0 || t.Capabilities.Resume || t.Capabilities.Cancel || t.Capabilities.Approval || t.Capabilities.Attachments {
			return ErrBadEdit
		}
		return nil
	}
	if resumeProblem(PlanInput{Target: TargetNew, Identity: t.Identity, Env: t.Env}) != "" || t.Capabilities.Budget < 2 || t.Capabilities.Attachments || !utf8OK(t.Capabilities.Wrapper.Prefix) || !utf8OK(t.Capabilities.Wrapper.Suffix) {
		return ErrBadEdit
	}
	supported := false
	for _, mode := range t.Capabilities.PermissionModes {
		switch mode {
		case "ask", "deny", "bypass":
		default:
			return ErrPermission
		}
		if mode == t.Env.PermissionMode {
			supported = true
		}
	}
	if !supported {
		return ErrPermission
	}
	return nil
}
