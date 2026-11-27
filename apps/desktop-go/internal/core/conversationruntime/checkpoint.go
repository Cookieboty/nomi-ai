package conversationruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

const CheckpointVersion = 1

type TargetState struct {
	Identity     NativeIdentity
	Env          CompatibilityKey
	Effort       string `json:"effort,omitempty"`
	Capabilities Capabilities
}
type AttemptState struct {
	Token           AttemptToken
	Request         Request
	ReplyID         string
	Phase           Phase
	Recovery        RecoveryResult
	BindingID       string
	Plan            Plan
	Delivered       bool
	Draft           string
	Approvals       []string
	ApprovalDetails []ApprovalInfo `json:"approvalDetails,omitempty"`
	Detail          string
}

// Checkpoint is one logical commit unit, not an independent disk format. Raw
// legacy payloads live with their revision, never in a second transcript.
type SwitchState struct {
	Phase            string
	From, To         TargetState
	ExpectedStrategy Strategy `json:"expectedStrategy,omitempty"`
	PlannedEntries   int      `json:"plannedEntries,omitempty"`
	OmittedEntries   int      `json:"omittedEntries,omitempty"`
	Reason           string   `json:"reason,omitempty"`
}

type LastSwitchSummary struct {
	FromBackend      string   `json:"fromBackend"`
	ToBackend        string   `json:"toBackend"`
	ExpectedStrategy Strategy `json:"expectedStrategy"`
	PlannedEntries   int      `json:"plannedEntries"`
	OmittedEntries   int      `json:"omittedEntries"`
	ResumableBinding string   `json:"resumableBinding,omitempty"`
	CommittedAt      int64    `json:"committedAt"`
}

func cloneSwitchState(s *SwitchState) *SwitchState {
	if s == nil {
		return nil
	}
	x := *s
	x.From.Capabilities = x.From.Capabilities.clone()
	x.To.Capabilities = x.To.Capabilities.clone()
	return &x
}

func cloneLastSwitch(s *LastSwitchSummary) *LastSwitchSummary {
	if s == nil {
		return nil
	}
	x := *s
	return &x
}

type Checkpoint struct {
	Version        int
	ConversationID string
	Generation     uint64
	History        []Entry
	Bindings       []Binding
	Preferred      map[string]string
	Receipts       map[string]string
	Completed      map[string]int
	Attempted      map[string]bool
	Held           map[string]bool `json:"held,omitempty"`
	Queue          []Request
	Work           Activity
	Selected       TargetState
	Active         *AttemptState
	PendingSwitch  *SwitchState
	LastSwitch     *LastSwitchSummary `json:"lastSwitch,omitempty"`
}

// Committer must publish the WHOLE checkpoint atomically and durably. Any error
// halts the session; callers must reopen/recover instead of retrying side effects.
type Committer interface{ Commit(Checkpoint) error }

func (c *Session) snapshotLocked() Checkpoint {
	out := Checkpoint{Version: CheckpointVersion, ConversationID: c.id, Generation: c.generation,
		Bindings: c.bindings.All(), Preferred: map[string]string{}, Receipts: map[string]string{}, Completed: map[string]int{}, Attempted: map[string]bool{}, Work: c.work,
		Selected: TargetState{Identity: c.target.Identity, Env: c.target.Env, Effort: c.target.Effort, Capabilities: c.caps.clone()}}
	out.PendingSwitch = cloneSwitchState(c.pendingSwitch)
	out.LastSwitch = cloneLastSwitch(c.lastSwitch)
	c.ledger.mu.Lock()
	for _, id := range c.ledger.order {
		versions := c.ledger.history[id]
		for rev := 1; rev <= len(versions); rev++ {
			out.History = append(out.History, copyEntry(versions[rev]))
		}
	}
	for id, key := range c.ledger.committed {
		out.Receipts[id] = key
	}
	c.ledger.mu.Unlock()
	for k, v := range c.preferred {
		out.Preferred[k] = v
	}
	for k, v := range c.completed {
		out.Completed[k] = v
	}
	for k, v := range c.attempted {
		out.Attempted[k] = v
	}
	for k, v := range c.held {
		if v {
			if out.Held == nil {
				out.Held = map[string]bool{}
			}
			out.Held[k] = true
		}
	}
	out.Queue = append([]Request(nil), c.queue...)
	for i := range out.Queue {
		out.Queue[i].Attachments = append([]string(nil), out.Queue[i].Attachments...)
		out.Queue[i].Images = append([]string(nil), out.Queue[i].Images...)
	}
	if a := c.active; a != nil {
		out.Active = &AttemptState{Token: a.token, Request: a.request, ReplyID: a.replyID, Phase: a.phase, Recovery: a.recovery, BindingID: a.binding.ID,
			Plan: clonePlan(a.plan), Delivered: a.delivered, Draft: a.text, Detail: a.detail}
		out.Active.Request.Attachments = append([]string(nil), a.request.Attachments...)
		out.Active.Request.Images = append([]string(nil), a.request.Images...)
		for id := range a.approvals {
			out.Active.Approvals = append(out.Active.Approvals, id)
		}
		sort.Strings(out.Active.Approvals)
		for _, id := range out.Active.Approvals {
			if info, ok := a.approvalDetails[id]; ok {
				out.Active.ApprovalDetails = append(out.Active.ApprovalDetails, info)
			}
		}
	}
	return out
}
func (c *Session) Checkpoint() Checkpoint {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshotLocked()
}

// RestoreCheckpoint never starts a runtime, replays a request or resolves an
// approval. Every restart fences the old generation; unfinished work is unknown.
func RestoreCheckpoint(in Checkpoint) (*Session, error) { return restoreCheckpoint(in, true) }
func restoreCheckpoint(in Checkpoint, restart bool) (*Session, error) {
	if err := ValidateCheckpoint(in); err != nil {
		return nil, err
	}
	// Round-trip prevents the caller retaining pointers into restored authority.
	encoded, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	var cp Checkpoint
	if err = json.Unmarshal(encoded, &cp); err != nil {
		return nil, err
	}
	c, _ := NewSession(cp.ConversationID, nil)
	c.pendingSwitch = cp.PendingSwitch
	c.lastSwitch = cp.LastSwitch
	c.generation = cp.Generation
	c.work = cp.Work
	c.preferred = cp.Preferred
	c.completed = cp.Completed
	c.attempted = cp.Attempted
	c.held = cp.Held
	c.queue = cp.Queue
	if c.preferred == nil {
		c.preferred = map[string]string{}
	}
	if c.completed == nil {
		c.completed = map[string]int{}
	}
	if c.attempted == nil {
		c.attempted = map[string]bool{}
	}
	if c.held == nil {
		c.held = map[string]bool{}
	}
	c.target.Identity, c.target.Env, c.target.Effort = cp.Selected.Identity, cp.Selected.Env, cp.Selected.Effort
	c.caps = cp.Selected.Capabilities.clone()
	for _, e := range cp.History {
		c.ledger.put(e)
		if e.Order >= c.ledger.next {
			c.ledger.next = e.Order + 1
		}
	}
	for k, v := range cp.Receipts {
		c.ledger.committed[k] = v
	}
	for _, b := range cp.Bindings {
		if err := c.bindings.Put(b); err != nil {
			return nil, err
		}
	}
	if cp.Active != nil {
		x := cp.Active
		ctx, cancel := context.WithCancel(context.Background())
		a := &activeAttempt{token: x.Token, request: x.Request, replyID: x.ReplyID, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1), target: c.target, caps: c.caps.clone(),
			phase: x.Phase, recovery: x.Recovery, plan: x.Plan, delivered: x.Delivered, text: x.Draft, detail: x.Detail, approvals: map[string]bool{}, approvalDetails: map[string]ApprovalInfo{}}
		a.binding, _ = c.bindings.Get(x.BindingID)
		if !restart {
			for _, id := range x.Approvals {
				a.approvals[id] = true
			}
			for _, info := range x.ApprovalDetails {
				a.approvalDetails[info.ID] = info
			}
		}
		c.active = a
	}
	if restart {
		if c.generation == ^uint64(0) {
			return nil, ErrBadEdit
		}
		c.generation++
		switchInterrupted := cp.PendingSwitch != nil
		turnUnsafe := !c.work.Idle()
		if a := c.active; a != nil {
			switch a.phase {
			case PhasePreparing, PhaseRunning, PhaseCanceling, PhaseUncertain:
				turnUnsafe = true
			}
			a.cancel() // restored operations can only be canceled/probed, never resumed implicitly
		}
		if turnUnsafe {
			if c.active == nil {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				c.active = &activeAttempt{token: AttemptToken{ConversationID: c.id, AttemptID: "interrupted-work", Generation: cp.Generation}, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1), target: c.target, caps: c.caps.clone(), approvals: map[string]bool{}, approvalDetails: map[string]ApprovalInfo{}}
			}
			c.active.phase, c.active.detail = PhaseUncertain, "restart interrupted send or background work; no automatic replay"
			c.work = Activity{}
			c.invalidateBindingLocked(c.active)
		} else if switchInterrupted {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			c.active = &activeAttempt{token: AttemptToken{ConversationID: c.id, AttemptID: "interrupted-switch", Generation: cp.Generation}, ctx: ctx, cancel: cancel, gate: make(chan struct{}, 1), target: c.target, caps: c.caps.clone(), phase: PhaseUncertain, detail: "restart interrupted backend switch; rollback or resolve explicitly", approvals: map[string]bool{}, approvalDetails: map[string]ApprovalInfo{}}
			c.work = Activity{}
		}
	}
	return c, nil
}

// Reattach installs an implementation for the SAME persisted target. It does
// not recover/start a turn or change its permission, identity or generation.
func (c *Session) Reattach(target Target) error {
	if target.Runtime == nil {
		return ErrBadEdit
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.storageErr != nil {
		return c.storageErr
	}
	if c.target.Identity.Key(c.target.Env) != target.Identity.Key(target.Env) {
		return ErrStaleBinding
	}
	c.target.Runtime = target.Runtime
	if liveReqBudget := target.Runtime.Capabilities().RequestBudget; liveReqBudget > c.caps.RequestBudget {
		c.caps.RequestBudget = liveReqBudget
		if c.active != nil && liveReqBudget > c.active.caps.RequestBudget {
			c.active.caps.RequestBudget = liveReqBudget
		}
	}
	if c.active != nil {
		c.active.target.Runtime = target.Runtime
	}
	return nil
}

func (c *Session) AttachCommitter(sink Committer) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if sink == nil || c.committer != nil {
		return ErrBadEdit
	}
	if c.active != nil && (c.active.phase == PhasePreparing || c.active.phase == PhaseRunning || c.active.phase == PhaseCanceling) {
		return ErrBusy // cannot retroactively make a live dispatch durable
	}
	c.committer = sink
	c.lastCheckpoint = c.snapshotLocked()
	return c.persistLocked()
}
func (c *Session) persistLocked() error {
	if c.storageErr != nil {
		return c.storageErr
	}
	if c.committer == nil {
		return nil
	}
	next := c.snapshotLocked()
	if err := c.committer.Commit(next); err != nil {
		// Roll back all public transcript/coverage to the last successful unit.
		// Then fence in-memory work too. A post-rename error may have published the
		// complete NEW unit; only reopen can determine it, never replay this session.
		generation := c.generation
		if c.active != nil {
			c.active.cancel()
		}
		restored, restoreErr := restoreCheckpoint(c.lastCheckpoint, false)
		if restoreErr == nil {
			c.ledger, c.bindings, c.preferred, c.completed, c.attempted, c.held, c.queue = restored.ledger, restored.bindings, restored.preferred, restored.completed, restored.attempted, restored.held, restored.queue
			c.active = restored.active
			c.pendingSwitch, c.lastSwitch, c.target, c.caps = restored.pendingSwitch, restored.lastSwitch, restored.target, restored.caps
		}
		c.generation = generation + 1
		c.work = Activity{}
		c.storageErr = fmt.Errorf("runtime persistence halted; reopen required: %w", err)
		if c.active != nil {
			c.active.cancel()
			c.active.phase, c.active.detail = PhaseUncertain, c.storageErr.Error()
		}
		return c.storageErr
	}
	c.lastCheckpoint = next
	return nil
}
