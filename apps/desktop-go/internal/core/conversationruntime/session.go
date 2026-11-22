package conversationruntime

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

type activeAttempt struct {
	token     AttemptToken
	request   Request
	replyID   string
	ctx       context.Context
	cancel    context.CancelFunc
	gate      chan struct{} // serializes Start/Approve/Cancel without holding session.mu
	target    Target
	caps      Capabilities
	phase     Phase
	recovery  RecoveryResult
	binding   Binding
	plan      Plan
	delivered bool
	text      string
	approvals map[string]bool
	detail    string
}

// Session is an IN-MEMORY behavior harness for one stable product conversation.
// All product writes and event acceptance are serialized here. No CLI, model,
// disk, credentials or production ingress is connected. It must gain durable
// ownership/commit semantics before it can be used with production adapters.
type Session struct {
	mu          sync.Mutex
	id          string
	generation  uint64
	cancelRound uint64
	target      Target
	caps        Capabilities
	ledger      *Ledger
	bindings    *BindingStore
	active      *activeAttempt
	queue       []Request
	completed   map[string]int
	attempted   map[string]bool
	preferred   map[string]string
	work        Activity
}

// NewSession seeds ordered, unrevisioned fixtures only. It is deliberately not
// a durable restore API; B2 must restore versions/attempt ownership losslessly.
func NewSession(id string, history []Entry) (*Session, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("%w: empty conversation ID", ErrBadEdit)
	}
	c := &Session{id: id, ledger: NewLedger(), bindings: NewBindingStore(), preferred: map[string]string{}, completed: map[string]int{}, attempted: map[string]bool{}, work: Activity{Known: true}}
	for i, e := range history {
		if e.Revision > 1 || e.Revision < 0 || (e.Order != 0 && e.Order != int64(i+1)) {
			return nil, fmt.Errorf("%w: seed is not an unrevisioned ordered fixture; durable restore is not implemented", ErrBadEdit)
		}
		if _, err := c.ledger.Append(e); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func (c *Session) Select(target Target) error {
	if target.Runtime == nil {
		return fmt.Errorf("%w: missing runtime", ErrBadEdit)
	}
	caps := target.Runtime.Capabilities().clone()
	// Product attachments are not wired even if the native CLI can accept them.
	if caps.Attachments {
		caps.Degraded = append(caps.Degraded, "product attachment handoff is not implemented")
	}
	caps.Attachments = false
	// Only product-defined modes cross this boundary. Native flags do not
	// acquire permission just because an adapter puts them in a string list.
	modes := make([]string, 0, len(caps.PermissionModes))
	for _, mode := range caps.PermissionModes {
		switch mode {
		case "ask", "deny", "bypass":
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
		return ErrPermission
	}
	if !utf8OK(caps.Wrapper.Prefix) || !utf8OK(caps.Wrapper.Suffix) {
		return ErrInvalidUTF8
	}
	if caps.Budget < 2 {
		return &ErrBudget{Need: 2, Limit: int(caps.Budget), What: "minimum prompt"}
	}
	// Validate identity independently of any previous binding.
	if why := resumeProblem(PlanInput{Target: TargetNew, Identity: target.Identity, Env: target.Env}); why != "" {
		return fmt.Errorf("%w: %s", ErrBadEdit, why)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.idleLocked(false) {
		return ErrBusy
	}
	c.generation++
	c.target, c.caps = target, caps
	return nil
}

func (c *Session) State() SessionState {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshLocked()
	s := SessionState{ConversationID: c.id, Generation: c.generation, Phase: PhaseIdle, Capabilities: c.caps.clone(), Work: c.work, Queued: len(c.queue)}
	if a := c.active; a != nil {
		s.Phase, s.Token, s.Recovery, s.Partial, s.Detail = a.phase, a.token, a.recovery, a.text, a.detail
		for id := range a.approvals {
			s.Approvals = append(s.Approvals, id)
		}
		sort.Strings(s.Approvals)
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
	return nil
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
	}
	c.mu.Unlock()
	if err != nil {
		return AttemptToken{}, err
	}
	return a.token, c.launch(a)
}
func (c *Session) Start(ctx context.Context, r Request) (AttemptToken, error) {
	c.mu.Lock()
	a, err := c.beginLocked(ctx, r, false)
	c.mu.Unlock()
	if err != nil {
		return AttemptToken{}, err
	}
	return a.token, c.launch(a)
}

func (c *Session) validateRequestLocked(r Request) error {
	if strings.TrimSpace(r.MessageID) == "" || strings.TrimSpace(r.TurnID) == "" || !utf8OK(r.Text) || !utf8OK(r.MessageID) || !utf8OK(r.TurnID) {
		return ErrBadEdit
	}
	if len(r.Attachments) > 0 {
		return fmt.Errorf("%w: product attachments unsupported", ErrBadEdit)
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
		if _, err := c.ledger.Append(Entry{ID: r.MessageID, TurnID: r.TurnID, Role: "user", Origin: "user", Text: r.Text}); err != nil {
			return nil, err
		}
	}
	c.generation++
	token := AttemptToken{ConversationID: c.id, AttemptID: fmt.Sprintf("a%d", c.generation), Generation: c.generation}
	attemptCtx, cancel := context.WithCancel(ctx)
	a := &activeAttempt{token: token, request: r, ctx: attemptCtx, cancel: cancel, gate: make(chan struct{}, 1), target: c.target, caps: c.caps.clone(), phase: PhasePreparing, approvals: map[string]bool{}}
	a.replyID = c.replyIDLocked("reply_" + token.AttemptID)
	c.active = a
	c.attempted[r.MessageID] = true
	c.work = Activity{Known: true, Running: true}
	return a, nil
}
func (c *Session) idleLocked(ignoreQueue bool) bool {
	c.refreshLocked()
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
		}
	}
	return true
}
func (c *Session) ownerLocked(a *activeAttempt) bool {
	return c.active == a && a.token.Generation == c.generation
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
	c.work = Activity{}
	c.invalidateBindingLocked(a)
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
	for i, r := range c.queue {
		if r.MessageID == messageID {
			c.queue = append(c.queue[:i], c.queue[i+1:]...)
			return nil
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
