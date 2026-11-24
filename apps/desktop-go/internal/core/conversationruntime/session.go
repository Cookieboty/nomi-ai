package conversationruntime

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type activeAttempt struct {
	token             AttemptToken
	request           Request
	replyID           string
	ctx               context.Context
	cancel            context.CancelFunc
	gate              chan struct{} // serializes Start/Approve/Cancel without holding session.mu
	target            Target
	caps              Capabilities
	phase             Phase
	recovery          RecoveryResult
	binding           Binding
	plan              Plan
	delivered         bool
	text              string
	startedAt         int64
	streamText        string
	streamThinking    string
	thinkingStartedAt int64
	thinkingActive    bool
	approvals         map[string]bool
	approvalDetails   map[string]ApprovalInfo
	trace             []TraceEntry
	detail            string
}

// Session serializes one stable product conversation. With an attached
// Committer every authority transition is durable before external dispatch;
// without one it is a pure in-memory harness. Production ingress and real
// runtime adapters are not connected yet.
type Session struct {
	switching      bool // process-local preparation/cleanup lease; not restored from checkpoints
	pendingSwitch  *SwitchState
	lastSwitch     *LastSwitchSummary
	committer      Committer
	lastCheckpoint Checkpoint
	storageErr     error
	mu             sync.Mutex
	id             string
	generation     uint64
	cancelRound    uint64
	target         Target
	caps           Capabilities
	ledger         *Ledger
	bindings       *BindingStore
	active         *activeAttempt
	queue          []Request
	completed      map[string]int
	attempted      map[string]bool
	held           map[string]bool
	preferred      map[string]string
	work           Activity
}

// NewSession seeds ordered, unrevisioned fixtures only. It is deliberately not
// a durable restore API; use RestoreCheckpoint for persisted revisions/fences.
func NewSession(id string, history []Entry) (*Session, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("%w: empty conversation ID", ErrBadEdit)
	}
	c := &Session{id: id, ledger: NewLedger(), bindings: NewBindingStore(), preferred: map[string]string{}, completed: map[string]int{}, attempted: map[string]bool{}, held: map[string]bool{}, work: Activity{Known: true}}
	for i, e := range history {
		if e.Revision > 1 || e.Revision < 0 || (e.Order != 0 && e.Order != int64(i+1)) {
			return nil, fmt.Errorf("%w: seed is not an unrevisioned ordered fixture; use RestoreCheckpoint", ErrBadEdit)
		}
		if _, err := c.ledger.Append(e); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func validateAndNormalizeTarget(target Target) (Capabilities, error) {
	if target.Runtime == nil {
		return Capabilities{}, fmt.Errorf("%w: missing runtime", ErrBadEdit)
	}
	caps := target.Runtime.Capabilities().clone()
	wiredAttachments := caps.Bridges != nil && (caps.Bridges.Attachments.Status == "bridged" || caps.Bridges.Attachments.Status == "native")
	if caps.Attachments && !wiredAttachments {
		caps.Degraded = append(caps.Degraded, "product attachment handoff is not implemented")
		caps.Attachments = false
	}
	if caps.Bridges != nil {
		for _, b := range []BridgeState{caps.Bridges.Computer, caps.Bridges.MCP, caps.Bridges.Persona, caps.Bridges.Memory, caps.Bridges.Knowledge, caps.Bridges.Skills, caps.Bridges.Attachments} {
			switch b.Status {
			case "native", "bridged", "degraded", "unsupported":
			default:
				return Capabilities{}, fmt.Errorf("%w: invalid capability bridge status %q", ErrBadEdit, b.Status)
			}
		}
	}
	// Only product-defined modes cross this boundary. Native flags do not
	// acquire permission just because an adapter puts them in a string list.
	modes := make([]string, 0, len(caps.PermissionModes))
	for _, mode := range caps.PermissionModes {
		switch mode {
		case "ask", "acceptEdits", "auto", "deny", "bypass":
			modes = append(modes, mode)
		default:
			caps.Degraded = append(caps.Degraded, "unsupported product permission mode: "+mode)
		}
	}
	caps.PermissionModes = modes
	supported := false
	for _, mode := range modes {
		if mode == target.Env.PermissionMode {
			supported = true
		}
	}
	if !supported || (target.Env.PermissionMode == "bypass" && !target.ConfirmUnsafe) {
		return Capabilities{}, ErrPermission
	}
	if !utf8OK(caps.Wrapper.Prefix) || !utf8OK(caps.Wrapper.Suffix) {
		return Capabilities{}, ErrInvalidUTF8
	}
	if caps.Budget < 2 {
		return Capabilities{}, &ErrBudget{Need: 2, Limit: int(caps.Budget), What: "minimum prompt"}
	}
	// Validate identity independently of any previous binding.
	if why := resumeProblem(PlanInput{Target: TargetNew, Identity: target.Identity, Env: target.Env}); why != "" {
		return Capabilities{}, fmt.Errorf("%w: %s", ErrBadEdit, why)
	}
	return caps, nil
}

func (c *Session) Select(target Target) error {
	caps, err := validateAndNormalizeTarget(target)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.idleLocked(false) {
		return ErrBusy
	}
	c.generation++
	c.target, c.caps = target, caps
	return c.persistLocked()
}

func normalizeSessionSource(backend, raw string) string {
	if backend == "" || backend == "api" {
		return ""
	}
	switch raw {
	case "local", "official", "thirdParty":
		return raw
	case "official-default-login-unverified":
		return "local"
	default:
		return ""
	}
}

func (c *Session) State() SessionState {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	s := SessionState{
		Backend:        c.target.Identity.DriverID,
		Source:         normalizeSessionSource(c.target.Identity.DriverID, c.target.Identity.Source),
		ConversationID: c.id,
		Generation:     c.generation,
		Phase:          PhaseIdle,
		Capabilities:   c.caps.clone(),
		Work:           c.work,
		Queued:         len(c.queue),
		Model:          c.target.Env.Model,
		AccountID:      c.target.Identity.AccountID,
		PermissionMode: c.target.Env.PermissionMode,
		Effort:         c.target.Effort,
		PendingSwitch:  cloneSwitchState(c.pendingSwitch),
		LastSwitch:     cloneLastSwitch(c.lastSwitch),
	}
	if c.storageErr != nil {
		s.Detail = c.storageErr.Error()
		s.Phase = PhaseUncertain
	}
	if a := c.active; a != nil {
		s.Phase, s.Token, s.Recovery, s.Partial, s.Detail = a.phase, a.token, a.recovery, a.text, a.detail
		if a.phase == PhaseRunning {
			if s.Partial == "" && a.streamText != "" {
				s.Partial = a.streamText
			}
			s.Thinking = a.streamThinking
			s.ThinkingActive = a.thinkingActive
		}
		if c.storageErr != nil {
			s.Phase = PhaseUncertain
			s.Detail = c.storageErr.Error()
		}
		for id := range a.approvals {
			s.Approvals = append(s.Approvals, id)
		}
		sort.Strings(s.Approvals)
		if len(s.Approvals) > 0 {
			s.ApprovalDetails = make([]ApprovalInfo, 0, len(s.Approvals))
			for _, id := range s.Approvals {
				if info, ok := a.approvalDetails[id]; ok {
					s.ApprovalDetails = append(s.ApprovalDetails, info)
				} else {
					s.ApprovalDetails = append(s.ApprovalDetails, ApprovalInfo{ID: id})
				}
			}
		}
		if len(a.trace) > 0 {
			s.Trace = append([]TraceEntry(nil), a.trace...)
		}
		if (a.phase == PhaseFailed || a.phase == PhaseUncertain || a.phase == PhaseCanceled) &&
			a.request.MessageID != "" &&
			a.token.AttemptID != "interrupted-switch" &&
			a.token.AttemptID != "interrupted-work" {
			reqCopy := a.request
			reqCopy.Attachments = append([]string(nil), a.request.Attachments...)
			reqCopy.Images = append([]string(nil), a.request.Images...)
			s.FailedRequest = &reqCopy
		}
	}
	return s
}
func (c *Session) Messages() []Entry   { c.mu.Lock(); defer c.mu.Unlock(); return c.ledger.Snapshot() }
func (c *Session) Bindings() []Binding { c.mu.Lock(); defer c.mu.Unlock(); return c.bindings.All() }
func (c *Session) Edit(id, text string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.idleLocked(false) {
		return ErrBusy
	}
	_, err := c.ledger.Edit(c.bindings, id, text)
	if err == nil {
		err = c.persistLocked()
	}
	return err
}

// Enqueue never runs a turn automatically. StartNext is an explicit operation;
// duplicate queued/completed IDs cannot become an accidental second execution.
func (c *Session) Enqueue(r Request) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.validateRequestLocked(r); err != nil {
		return err
	}
	for _, old := range c.queue {
		if old.MessageID == r.MessageID {
			return ErrAlreadyExecuted
		}
	}
	c.queue = append(c.queue, r)
	return c.persistLocked()
}
func (c *Session) StartNext(ctx context.Context) (AttemptToken, error) {
	c.mu.Lock()
	if len(c.queue) == 0 {
		c.mu.Unlock()
		return AttemptToken{}, ErrUnknownEntry
	}
	r := c.queue[0]
	a, err := c.beginLocked(ctx, r, true)
	if err == nil {
		c.queue = c.queue[1:]
		err = c.persistLocked()
	}
	c.mu.Unlock()
	if err != nil {
		return AttemptToken{}, err
	}
	return a.token, c.launch(a)
}
func (c *Session) Start(ctx context.Context, r Request) (AttemptToken, error) {
	return c.startAt(ctx, r, nil)
}
func (c *Session) StartAt(ctx context.Context, r Request, generation uint64) (AttemptToken, error) {
	return c.startAt(ctx, r, &generation)
}
func (c *Session) startAt(ctx context.Context, r Request, expected *uint64) (AttemptToken, error) {
	c.mu.Lock()
	if expected != nil && *expected != c.generation {
		c.mu.Unlock()
		return AttemptToken{}, ErrStaleEvent
	}
	a, err := c.beginLocked(ctx, r, false)
	if err == nil {
		err = c.persistLocked()
	}
	c.mu.Unlock()
	if err != nil {
		return AttemptToken{}, err
	}
	return a.token, c.launch(a)
}

func (c *Session) validateRequestLocked(r Request) error {
	if c.storageErr != nil {
		return c.storageErr
	}
	if strings.TrimSpace(r.MessageID) == "" || strings.TrimSpace(r.TurnID) == "" || !utf8OK(r.Text) || !utf8OK(r.MessageID) || !utf8OK(r.TurnID) {
		return ErrBadEdit
	}
	if len(r.Attachments) > 0 {
		return fmt.Errorf("%w: product attachments unsupported", ErrBadEdit)
	}
	for _, img := range r.Images {
		if strings.TrimSpace(img) == "" || !utf8OK(img) {
			return ErrBadEdit
		}
	}
	if len(r.Images) > 0 && !c.caps.Attachments {
		return fmt.Errorf("%w: active backend %s does not support image attachments", ErrBadEdit, c.target.Identity.DriverID)
	}
	if a := c.active; a != nil {
		if r.MessageID == a.replyID {
			return ErrAlreadyExecuted
		}
		if r.MessageID == a.request.MessageID && (a.phase == PhasePreparing || a.phase == PhaseRunning || a.phase == PhaseCanceling) {
			return ErrBusy
		}
	}
	latest, exists := c.ledger.Latest(r.MessageID)
	if (c.completed[r.MessageID] > 0 && (!exists || latest.Revision <= c.completed[r.MessageID])) || (c.attempted[r.MessageID] && !r.Retry) {
		return ErrAlreadyExecuted
	}
	if e, ok := c.ledger.Latest(r.MessageID); ok && (!r.Retry || e.Tombstone || e.Role != "user" || e.Text != r.Text || e.TurnID != r.TurnID) {
		return ErrAlreadyExecuted
	}
	return nil
}
func (c *Session) beginLocked(ctx context.Context, r Request, queued bool) (*activeAttempt, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, fmt.Errorf("%w: inactive context", ErrBadEdit)
	}
	if !c.idleLocked(queued) {
		return nil, ErrBusy
	}
	if c.target.Runtime == nil {
		return nil, ErrBadEdit
	}
	if err := c.validateRequestLocked(r); err != nil {
		return nil, err
	}
	if jsonLen(r.Text) > int(c.caps.Budget) {
		return nil, &ErrBudget{Need: jsonLen(r.Text), Limit: int(c.caps.Budget), What: "current request"}
	}
	if _, ok := c.ledger.Latest(r.MessageID); !ok {
		if _, err := c.ledger.Append(Entry{ID: r.MessageID, TurnID: r.TurnID, Role: "user", Origin: "user", Timestamp: time.Now().UnixMilli(), Text: r.Text}); err != nil {
			return nil, err
		}
	}
	c.generation++
	token := AttemptToken{ConversationID: c.id, AttemptID: fmt.Sprintf("a%d", c.generation), Generation: c.generation}
	attemptCtx, cancel := context.WithCancel(ctx)
	a := &activeAttempt{token: token, request: r, ctx: attemptCtx, cancel: cancel, gate: make(chan struct{}, 1), target: c.target, caps: c.caps.clone(), phase: PhasePreparing, startedAt: time.Now().UnixMilli(), approvals: map[string]bool{}, approvalDetails: map[string]ApprovalInfo{}}
	a.replyID = c.replyIDLocked("reply_" + token.AttemptID)
	c.active = a
	c.attempted[r.MessageID] = true
	c.work = Activity{Known: true, Running: true}
	return a, nil
}
func (c *Session) idleLocked(ignoreQueue bool) bool {
	if c.switching || c.pendingSwitch != nil {
		return false
	}
	return c.idleWorkLocked(ignoreQueue)
}

// idleWorkLocked checks source work without hiding a live switch marker from
// refreshLocked, whose uncertainty transition can write a checkpoint.
func (c *Session) idleWorkLocked(ignoreQueue bool) bool {
	c.refreshLocked()
	if c.storageErr != nil {
		return false
	}
	if !ignoreQueue && len(c.queue) > 0 {
		return false
	}
	if !c.work.Idle() {
		return false
	}
	if a := c.active; a != nil {
		if len(a.approvals) > 0 {
			return false
		}
		switch a.phase {
		case PhasePreparing, PhaseRunning, PhaseCanceling, PhaseUncertain:
			return false
		case PhaseCanceled:
			if a.recovery.Kind == RecoveryUnknown && c.hasSafeBindingLocked(a.target) {
				return false
			}
		}
	}
	return true
}

func (c *Session) hasSafeBindingLocked(target Target) bool {
	if target.Identity.DriverID == "" {
		return false
	}
	key := target.Identity.Key(target.Env)
	for _, b := range c.bindings.All() {
		if b.CompatKey == key && b.Status.Safe() && b.NativeSessionID != "" {
			return true
		}
	}
	return false
}
func (c *Session) ownerLocked(a *activeAttempt) bool {
	return c.storageErr == nil && c.active == a && a.token.Generation == c.generation
}
func (c *Session) refreshLocked() {
	if a := c.active; a != nil && (a.phase == PhaseRunning || a.phase == PhasePreparing || (a.phase == PhaseCompleted && !c.work.Idle())) && a.ctx.Err() != nil {
		c.uncertainLocked(a, "attempt context canceled without proven stop")
	}
}
func (c *Session) uncertainLocked(a *activeAttempt, why string) {
	if !c.ownerLocked(a) {
		return
	}
	a.phase, a.detail = PhaseUncertain, why
	c.generation++
	a.cancel()
	a.approvals = map[string]bool{}
	a.approvalDetails = map[string]ApprovalInfo{}
	c.work = Activity{}
	c.invalidateBindingLocked(a)
	_ = c.persistLocked()
}
func (c *Session) invalidateBindingLocked(a *activeAttempt) {
	c.bindings.mu.Lock()
	defer c.bindings.mu.Unlock()
	if b, ok := c.bindings.b[a.binding.ID]; ok {
		b.Status = StatusUnknown
		c.bindings.b[b.ID] = b
	}
}
func gate(ctx context.Context, a *activeAttempt) error {
	select {
	case a.gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func ungate(a *activeAttempt) { <-a.gate }

// DropQueued is an explicit removal, never an execution or automatic retry.
func (c *Session) DropQueued(messageID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.storageErr != nil {
		return c.storageErr
	}
	for i, r := range c.queue {
		if r.MessageID == messageID {
			c.queue = append(c.queue[:i], c.queue[i+1:]...)
			return c.persistLocked()
		}
	}
	return ErrUnknownEntry
}

func (c *Session) replyIDLocked(base string) string {
	for n := 0; ; n++ {
		id := base
		if n > 0 {
			id = fmt.Sprintf("%s_%d", base, n)
		}
		if _, ok := c.ledger.Latest(id); ok {
			continue
		}
		queued := false
		for _, r := range c.queue {
			if r.MessageID == id {
				queued = true
				break
			}
		}
		if !queued {
			return id
		}
	}
}
