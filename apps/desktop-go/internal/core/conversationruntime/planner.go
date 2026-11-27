package conversationruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Plan prepares either bounded full history (explicit new/fallback session)
// or unseen spans for one confirmed compatible native binding. No coverage is
// changed until Commit receives a confirmation. Ordering follows product order.
func (l *Ledger) Plan(in PlanInput) (Plan, error) {
	if l == nil {
		return Plan{}, fmt.Errorf("conversationruntime: nil ledger")
	}
	texts := append([]string{in.RequestText, in.Wrapper.Prefix, in.Wrapper.Suffix}, in.Attachments...)
	for _, s := range texts {
		if !utf8OK(s) {
			return Plan{}, ErrInvalidUTF8
		}
	}
	if len(in.Attachments) > 0 {
		return Plan{}, fmt.Errorf("conversationruntime: current request attachments unsupported; remove them or select a supporting runtime")
	}
	if in.HistoryBeforeOrder < 0 || (in.HistoryBeforeOrder > 0 && in.Target != TargetNew) {
		return Plan{}, fmt.Errorf("%w: explicit history cutoff requires a new native session", ErrStaleBinding)
	}
	snap := l.Snapshot()
	// Treat malformed imported coverage conservatively; in particular a byte
	// span inside an emoji must never lead to slicing invalid UTF-8.
	in.Binding = in.Binding.clone()
	for _, e := range snap {
		if pc, ok := in.Binding.Coverage.Partial[e.ID]; ok {
			if ValidateRanges(pc.Ranges, e.Text) != nil {
				delete(in.Binding.Coverage.Partial, e.ID)
			}
		}
	}
	cur := in.CurrentEntryID
	if cur == "" && in.CurrentTurnID != "" {
		for _, e := range snap {
			if e.TurnID == in.CurrentTurnID && e.Role == "user" && !e.Tombstone {
				if cur != "" {
					return Plan{}, fmt.Errorf("%w: ambiguous current turn; supply CurrentEntryID", ErrBadEdit)
				}
				cur = e.ID
			}
		}
	}
	p := Plan{Strategy: StrategyNone, BindingID: in.Binding.ID, BindingKey: in.Binding.CompatKey,
		NativeSessionID: in.Binding.NativeSessionID, TargetDigest: TextDigest(in.RequestText),
		Selections: []Selection{}, Omitted: []Omission{}, RequestBody: in.RequestText,
		RequestBytes: jsonLen(in.RequestText)}
	current := find(snap, cur)
	if current.ID != "" {
		if current.Tombstone || current.Role != "user" || current.Text != in.RequestText || len(current.Attachments) > 0 ||
			(in.CurrentTurnID != "" && current.TurnID != in.CurrentTurnID) {
			return p, fmt.Errorf("%w: current request does not match its ledger entry", ErrBadEdit)
		}
		p.TargetRev = current.Revision
		p.Lineage = &Lineage{ID: current.ID, Rev: current.Revision, Digest: p.TargetDigest}
	} else if in.RequestInLedger || cur != "" {
		return p, fmt.Errorf("%w: current request entry %q", ErrUnknownEntry, cur)
	}
	// Even an empty JSON string costs two bytes. Never silently clip a request.
	reqLimit := int(effectiveRequestBudget(in.Budget, in.RequestBudget))
	if p.RequestBytes > reqLimit {
		return p, &ErrBudget{Need: p.RequestBytes, Limit: reqLimit, What: "current request"}
	}
	if why := resumeProblem(in); why != "" {
		p.Strategy, p.Error = StrategyBlocked, why
		return p, nil
	}
	if in.Target == TargetNew {
		p.Strategy = StrategyNewSession
		p.BindingKey, p.NativeSessionID = in.Identity.Key(in.Env), ""
	}
	cands := deltaCandidates(snap, in, cur)
	lines := make([]string, 0, len(cands))
	payload := func(ls []string) (string, string) {
		h := in.Wrapper.apply(joinLines(ls))
		if h == "" {
			return h, in.RequestText
		}
		return h, h + "\n" + in.RequestText
	}
	fits := func(line string) bool {
		_, v := payload(append(append([]string(nil), lines...), line))
		return jsonLen(v) <= int(in.Budget)
	}
	for _, c := range cands {
		if c.line != "" && fits(c.line) {
			lines = append(lines, c.line)
			p.Selections = append(p.Selections, c.sel)
			continue
		}
		o := c.omit
		if fits(c.omission) {
			lines = append(lines, c.omission)
			o.Reported = true
		}
		p.Omitted = append(p.Omitted, o)
	}
	if len(lines) > 0 && in.Target != TargetNew {
		p.Strategy = StrategyDelta
	}
	p.Handoff, p.Payload = payload(lines)
	p.PayloadBytes = jsonLen(p.Payload)
	p.ID = planID(in, p)
	p.seal = sealPlan(p)
	return p, nil
}

// resumeProblem explains why in cannot resume; "" means exactly resumable.
func resumeProblem(in PlanInput) string {
	for _, field := range []string{in.Identity.DriverID, in.Identity.Transport, in.Identity.DriverVersion, in.Identity.ResumeProtocol,
		in.Identity.Executable, in.Identity.Source, in.Identity.AccountID, in.Identity.ConfigDir, in.Identity.Cwd, in.Identity.LaunchFingerprint,
		in.Env.Model, in.Env.Effort, in.Env.PermissionMode} {
		if !utf8OK(field) {
			return "native identity/configuration is not valid UTF-8"
		}
	}
	for _, field := range []string{in.Identity.DriverID, in.Identity.Transport, in.Identity.DriverVersion,
		in.Identity.ResumeProtocol, in.Identity.Executable, in.Identity.Source, in.Identity.ConfigDir, in.Identity.Cwd} {
		if strings.TrimSpace(field) == "" {
			return "native identity is incomplete: resolve driver/configuration before sending"
		}
	}
	switch in.Target {
	case TargetNew:
		return "" // explicit new/fallback: bounded full, no inherited coverage
	case TargetCurrent, TargetResume:
	default:
		return fmt.Sprintf("recovery target %d is unresolved: resume the binding or start a new one explicitly", in.Target)
	}
	b := in.Binding
	if b.CompatKey == "" || b.CompatKey != in.Identity.Key(in.Env) {
		return "native identity or configuration changed: binding is incompatible, resolve by starting a new session"
	}
	switch b.Status {
	case StatusLive, StatusIdle:
	case StatusUnknown:
		return "previous execution result is unknown: retry, abandon or start a new session explicitly"
	case StatusStale:
		return "binding is stale (" + b.StaleReason + "): resolve by starting a new session"
	case StatusUnverified:
		return "binding is unverified: no proven resume handshake, resolve by starting a new session"
	default:
		return fmt.Sprintf("binding status %q is not safe to resume", b.Status)
	}
	if b.NativeSessionID == "" {
		return "binding has no confirmed native session: resolve by starting a new session"
	}
	return ""
}

// deltaCandidates are prior entries (never the current request, never
// tombstones) that the binding has not fully delivered. Entries with
// attachments are omitted, never absorbed.
func deltaCandidates(snap []Entry, in PlanInput, cur string) []candidate {
	out := []candidate{}
	for _, e := range snap {
		if e.Tombstone || e.ID == cur || in.HoldIDs[e.ID] || (in.HistoryBeforeOrder > 0 && e.Order >= in.HistoryBeforeOrder) {
			continue
		}
		cand := candidate{
			sel:  Selection{ID: e.ID, Rev: e.Revision, Role: e.Role, Digest: TextDigest(e.Text)},
			omit: Omission{ID: e.ID, Rev: e.Revision},
		}
		if len(e.Attachments) > 0 {
			cand.omit.Reason = ReasonAttachment
		} else if in.Target != TargetNew && in.Binding.Coverage.Covered(e.ID, e.Revision, cand.sel.Digest, len(e.Text)) {
			continue
		} else if len(e.Text) > 0 {
			cand.sel.Ranges = []ByteRange{{0, len(e.Text)}}
			if in.Target != TargetNew {
				if pc, ok := in.Binding.Coverage.Partial[e.ID]; ok && pc.Rev == e.Revision && pc.Digest == cand.sel.Digest {
					cand.sel.Ranges = unseenRanges(pc.Ranges, len(e.Text))
				}
			}
			var parts []string
			for _, r := range cand.sel.Ranges {
				label := cand.sel
				if r.Start != 0 || r.End != len(e.Text) {
					label.ID += fmt.Sprintf(":%d-%d", r.Start, r.End)
				}
				parts = append(parts, line(label, e.Text[r.Start:r.End]))
			}
			cand.line = joinLines(parts)
			cand.omit.Reason = ReasonBudget
		} else {
			continue // nothing to send and nothing to miss
		}
		cand.omission = omissionLine(cand.omit)
		out = append(out, cand)
	}
	return out
}

// candidate is one eligible entry with its prepared selection or omission.
type candidate struct {
	sel      Selection // zero Ranges = omitted
	line     string
	omit     Omission
	omission string
}

// unseenRanges complements validated, normalized coverage. Malformed imported
// coverage is not trusted: resend the whole revision rather than lose text.
func unseenRanges(covered []ByteRange, size int) []ByteRange {
	merged, err := normalizeRanges(covered, size)
	if err != nil {
		return []ByteRange{{0, size}}
	}
	var out []ByteRange
	start := 0
	for _, r := range merged {
		if start < r.Start {
			out = append(out, ByteRange{start, r.Start})
		}
		start = r.End
	}
	if start < size {
		out = append(out, ByteRange{start, size})
	}
	return out
}

func joinLines(lines []string) string { return strings.Join(lines, "\n") }

func find(snap []Entry, id string) Entry {
	for _, e := range snap {
		if e.ID == id {
			return e
		}
	}
	return Entry{}
}

// planID fingerprints everything the plan depends on, not just the request
// text: binding compatibility and native identity, request logical identity,
// revision and digest, strategy, selections (revision, digest, ranges),
// omissions, wrapper and the exact handoff bytes.
func planID(in PlanInput, p Plan) string {
	var b strings.Builder
	put := func(xs ...string) {
		for _, x := range xs {
			fmt.Fprintf(&b, "%d:%s|", len(x), x)
		}
	}
	put(string(p.Strategy), p.BindingID, in.Binding.CompatKey, in.Binding.NativeSessionID,
		in.Identity.DriverID, in.Identity.Transport, in.Identity.DriverVersion, in.Identity.ResumeProtocol,
		in.Identity.Executable, fmt.Sprint(in.Identity.ExecutableSize), fmt.Sprint(in.Identity.ExecutableMtimeMS),
		in.Identity.Source, in.Identity.AccountID, in.Identity.ConfigDir, fmt.Sprint(in.Identity.ConfigGen),
		in.Identity.Cwd, in.Identity.LaunchFingerprint, in.Env.Model, in.Env.Effort, in.Env.PermissionMode,
		"attempt", in.AttemptID, "cutoff", fmt.Sprint(in.HistoryBeforeOrder), "target", fmt.Sprint(in.Target), in.CurrentEntryID, in.CurrentTurnID,
		"request", fmt.Sprint(p.TargetRev), p.TargetDigest, p.RequestBody, in.Wrapper.Prefix, in.Wrapper.Suffix)
	if p.Lineage != nil {
		put("lineage", p.Lineage.ID, fmt.Sprint(p.Lineage.Rev), p.Lineage.Digest)
	}
	for _, s := range p.Selections {
		put("sel", s.ID, fmt.Sprint(s.Rev), s.Role, s.Digest)
		for _, r := range s.Ranges {
			put(fmt.Sprint(r.Start), fmt.Sprint(r.End))
		}
	}
	for _, o := range p.Omitted {
		put("omit", o.ID, fmt.Sprint(o.Rev), o.Reason)
	}
	holds := make([]string, 0, len(in.HoldIDs))
	for id, yes := range in.HoldIDs {
		if yes {
			holds = append(holds, id)
		}
	}
	sort.Strings(holds)
	put(append([]string{"hold"}, holds...)...)
	put("payload", p.Payload)
	sum := sha256.Sum256([]byte(b.String()))
	return "pl2_" + hex.EncodeToString(sum[:12])
}

// A plan is read-only after construction. The private checksum catches adapter
// mutations that would otherwise acknowledge ranges not present in Payload.
func sealPlan(p Plan) string {
	b, _ := json.Marshal(struct {
		Plan    Plan
		Lineage *Lineage
	}{p, p.Lineage})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
