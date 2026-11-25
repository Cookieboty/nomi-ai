package conversationruntime

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// DeliveryKind describes how the native runtime acknowledged exactly one plan.
// Only confirmed kinds may advance coverage; unknown and pre-submit failures
// never do.
type DeliveryKind int

const (
	// DeliveredUnknown means the outcome was never confirmed.
	DeliveredUnknown DeliveryKind = iota
	// DeliveredPreSubmitFailed means the CLI refused the turn before running it.
	DeliveredPreSubmitFailed
	// DeliveredFull means the CLI confirmed it received every planned
	// selection; the whole plan is claimed (with full-entry ranges).
	DeliveredFull
	// DeliveredPartial means the CLI confirmed it received some planned
	// content, reported as explicit typed spans (Delivery.Parts).
	DeliveredPartial
)

func (k DeliveryKind) String() string {
	switch k {
	case DeliveredFull:
		return "full"
	case DeliveredPartial:
		return "partial"
	case DeliveredPreSubmitFailed:
		return "pre-submit-failed"
	default:
		return "unknown"
	}
}

// Delivery is the confirmed acknowledgement for exactly one plan. There is no
// official CLI echo to search: callers (driver adapters) report either the
// whole plan or typed UTF-8 spans of the planned targets.
type Delivery struct {
	PlanID          string
	Kind            DeliveryKind
	NativeSessionID string // native identity reported by the runtime; "" = not reported
	Parts           []DeliveredPart
}

// DeliveredPart is the exact UTF-8 half-open span of entry ID@Rev that the
// native runtime received. It must lie inside one range of the plan.
type DeliveredPart struct {
	ID    string
	Rev   int
	Start int
	End   int
}

var (
	// ErrReceipt is returned for claims outside the plan or for a conflicting
	// repeat of an attempt.
	ErrReceipt = errors.New("conversationruntime: delivery receipt outside the plan")
	// ErrAlreadyCommitted reports a repeated receipt that differs from what
	// was already committed for this attempt (an identical repeat is a no-op).
	ErrAlreadyCommitted = errors.New("conversationruntime: receipt repeated with different content")
)

// Commit validates the whole delivery against the plan and the current
// ledger, then advances coverage atomically: either every claim is applied or
// no coverage changes. Unknown outcomes additionally block the binding.
// Staleness is compared per entry revision (the
// plan's selections and the edit invalidation boundaries), never against the
// a different entry's revision. Current request lineage is checked too. Lock order is store -> ledger everywhere; the
// store lock serializes commits, edits and rewinds. The native session ID of
// a binding is immutable: an identity or compatibility change is rejected,
// never applied. A repeated identical receipt is idempotent.
func (l *Ledger) Commit(store *BindingStore, plan Plan, d Delivery) error {
	if l == nil || store == nil {
		return errors.New("conversationruntime: nil ledger or store")
	}
	if plan.Strategy == StrategyBlocked {
		return ErrUnknownState
	}
	if plan.ID == "" || d.PlanID != plan.ID || plan.seal == "" || sealPlan(plan) != plan.seal {
		return fmt.Errorf("%w: got %q want %q", ErrPlanMismatch, d.PlanID, plan.ID)
	}
	if plan.Strategy != StrategyDelta && plan.Strategy != StrategyNewSession && plan.Strategy != StrategyNone {
		return fmt.Errorf("%w: plan has no selections to claim", ErrPlanMismatch)
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()

	switch d.Kind {
	case DeliveredFull, DeliveredPartial, DeliveredUnknown:
	case DeliveredPreSubmitFailed:
		return ErrUnconfirmed
	default:
		return fmt.Errorf("%w: unknown delivery kind %d", ErrUnconfirmed, d.Kind)
	}
	cur, ok := store.b[plan.BindingID]
	if !ok {
		return ErrNoSuchBinding
	}
	// Replays never re-apply claims. Validate referenced revisions even on a
	// replay, so an edit is not masked by the idempotency table.
	for _, sel := range plan.Selections {
		if err := checkSelectable(l, cur, sel); err != nil {
			return err
		}
	}
	if plan.Lineage != nil {
		if err := checkSelectable(l, cur, Selection{ID: plan.Lineage.ID, Rev: plan.Lineage.Rev, Digest: plan.Lineage.Digest}); err != nil {
			return err
		}
	}
	if seen, ok := l.committed[plan.ID]; ok {
		if seen != receiptKey(d) {
			return fmt.Errorf("%w: %s", ErrAlreadyCommitted, plan.ID)
		}
		return nil
	}
	if err := checkBindingPlan(cur, plan); err != nil {
		return err
	}
	if d.NativeSessionID != "" && cur.NativeSessionID != "" && d.NativeSessionID != cur.NativeSessionID {
		return fmt.Errorf("%w: receipt native identity differs", ErrStaleBinding)
	}
	if d.Kind == DeliveredUnknown {
		// Never downgrade an already committed plan due to a late unknown
		// event; the replay table above rejects that conflicting receipt.
		cur.Status = StatusUnknown
		store.b[cur.ID] = cur
		return ErrUnconfirmed
	}
	if plan.Strategy == StrategyNewSession && (cur.NativeSessionID != "" || len(cur.Coverage.Delivered)+len(cur.Coverage.Partial) != 0) {
		return fmt.Errorf("%w: full handoff requires a fresh binding", ErrStaleBinding)
	}
	if cur.NativeSessionID == "" && d.NativeSessionID == "" {
		return ErrUnconfirmed
	}
	next := cur.clone()
	// Resolve the claims for the whole batch before applying any of them.
	claims := map[string][]ByteRange{}
	if d.Kind == DeliveredFull {
		if len(d.Parts) != 0 {
			return fmt.Errorf("%w: full receipt cannot include partial claims", ErrReceipt)
		}
		for _, sel := range plan.Selections {
			claims[sel.ID] = sel.Ranges
		}
	} else {
		for _, part := range d.Parts {
			sel, ok := planSelection(plan, part.ID, part.Rev)
			if !ok {
				return fmt.Errorf("%w: %s@%d is not planned", ErrReceipt, part.ID, part.Rev)
			}
			span := ByteRange{part.Start, part.End}
			if err := ValidateRanges([]ByteRange{span}, l.latest[sel.ID].Text); err != nil {
				return err
			}
			if !containsRange(sel.Ranges, span) {
				return fmt.Errorf("%w: %s@%d [%d,%d) is not inside a planned range",
					ErrReceipt, part.ID, part.Rev, span.Start, span.End)
			}
			claims[sel.ID] = append(claims[sel.ID], span)
		}
		if len(claims) == 0 {
			return fmt.Errorf("%w: partial receipt has no planned spans", ErrNoCoverage)
		}
	}
	for id := range claims {
		sel, _ := planSelection(plan, id, selRev(plan, id))
		if err := recordCoverage(&next, l, sel, claims[id]); err != nil {
			return err
		}
		delete(next.InvalidatedByRev, id)
	}
	if d.Kind == DeliveredFull && plan.Lineage != nil {
		next.Coverage.Delivered[plan.Lineage.ID] = RevisionDigest{Rev: plan.Lineage.Rev, Digest: plan.Lineage.Digest}
		delete(next.Coverage.Partial, plan.Lineage.ID)
		delete(next.InvalidatedByRev, plan.Lineage.ID)
	}
	if d.NativeSessionID != "" && next.NativeSessionID == "" {
		// Only a binding that never had a native session may learn it; the
		// key was already proven identical to the planning identity.
		next.NativeSessionID = d.NativeSessionID
	}
	if next.Status == StatusUnverified {
		next.Status = StatusIdle
	} else {
		next.Status = StatusLive
	}
	store.b[plan.BindingID] = next
	l.committed[plan.ID] = receiptKey(d)
	return nil
}

func receiptKey(d Delivery) string {
	parts := append([]DeliveredPart(nil), d.Parts...)
	sort.Slice(parts, func(i, j int) bool {
		a, b := parts[i], parts[j]
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		if a.Rev != b.Rev {
			return a.Rev < b.Rev
		}
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		return a.End < b.End
	})
	encoded, _ := json.Marshal(struct {
		Kind            DeliveryKind
		NativeSessionID string
		Parts           []DeliveredPart
	}{d.Kind, d.NativeSessionID, parts})
	return string(encoded)
}

// checkBindingPlan verifies the binding still matches the planning identity:
// same key, same exact native session, safe status, and every selected entry
// still at its planned revision with no newer invalidation boundary.
func checkBindingPlan(b Binding, plan Plan) error {
	if b.ID != plan.BindingID {
		return fmt.Errorf("%w: binding %s", ErrPlanMismatch, plan.BindingID)
	}
	if b.CompatKey != plan.BindingKey {
		return fmt.Errorf("%w: compatibility of %s changed since planning", ErrStalePlan, plan.BindingID)
	}
	if b.NativeSessionID != plan.NativeSessionID {
		return fmt.Errorf("%w: native session of %s changed since planning", ErrStalePlan, plan.BindingID)
	}
	if !b.Status.Safe() {
		return fmt.Errorf("%w: binding status %q", ErrStalePlan, b.Status)
	}
	for _, sel := range plan.Selections {
		if boundary, ok := b.InvalidatedByRev[sel.ID]; ok && boundary > sel.Rev {
			return fmt.Errorf("%w: %s@%d invalidated by revision %d", ErrStalePlan, sel.ID, sel.Rev, boundary)
		}
	}
	return nil
}

func checkSelectable(l *Ledger, b Binding, sel Selection) error {
	e, ok := l.latest[sel.ID]
	if !ok || e.Revision != sel.Rev || TextDigest(e.Text) != sel.Digest {
		return fmt.Errorf("%w: %s@%d changed since planning", ErrStalePlan, sel.ID, sel.Rev)
	}
	if boundary, ok := b.InvalidatedByRev[sel.ID]; ok && boundary > sel.Rev {
		return fmt.Errorf("%w: %s@%d invalidated by revision %d", ErrStalePlan, sel.ID, sel.Rev, boundary)
	}
	return nil
}

func planSelection(p Plan, id string, rev int) (Selection, bool) {
	for _, s := range p.Selections {
		if s.ID == id && s.Rev == rev {
			return s, true
		}
	}
	return Selection{}, false
}

func selRev(p Plan, id string) int {
	for _, s := range p.Selections {
		if s.ID == id {
			return s.Rev
		}
	}
	return 0
}

func containsRange(ranges []ByteRange, r ByteRange) bool {
	for _, pr := range ranges {
		if r.Start >= pr.Start && r.End <= pr.End {
			return true
		}
	}
	return false
}

// recordCoverage merges ranges with any existing partial coverage of the same
// revision and stores full delivery when the union covers the entire text.
func recordCoverage(b *Binding, l *Ledger, sel Selection, ranges []ByteRange) error {
	e, ok := l.latest[sel.ID]
	if !ok || e.Revision != sel.Rev || TextDigest(e.Text) != sel.Digest {
		return fmt.Errorf("%w: %s@%d changed since planning", ErrStalePlan, sel.ID, sel.Rev)
	}
	var all []ByteRange
	if old, ok := b.Coverage.Partial[sel.ID]; ok && old.Rev == sel.Rev && old.Digest == sel.Digest {
		all = append(all, old.Ranges...)
	}
	all = append(all, ranges...)
	merged, err := normalizeRanges(all, len(e.Text))
	if err != nil {
		return err
	}
	delete(b.Coverage.Partial, sel.ID)
	if len(e.Text) > 0 && len(merged) == 1 && merged[0] == (ByteRange{0, len(e.Text)}) {
		b.Coverage.Delivered[sel.ID] = RevisionDigest{Rev: sel.Rev, Digest: sel.Digest}
		return nil
	}
	b.Coverage.Partial[sel.ID] = PartialCoverage{Rev: sel.Rev, Digest: sel.Digest, Ranges: merged}
	return nil
}
