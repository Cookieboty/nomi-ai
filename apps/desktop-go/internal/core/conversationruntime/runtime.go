package conversationruntime

import (
	"context"
	"errors"
)

// Runtime owns its agent loop and tools. Recover must NOT submit a user turn.
// RecoveryError is allowed only when preparation has left no active work.
// Start returns after submission, not after the agent loop finishes. Adapters
// must propagate the supplied token on every event and honor cancellation.
// Capabilities is metadata-only: it must not start processes or inspect login
// secrets. Native capabilities do not imply shared product bridges.
// Official adapters live in application packages; this package tests with fakes.
type Runtime interface {
	Capabilities() Capabilities
	Recover(context.Context, RecoveryRequest) RecoveryResult
	Start(context.Context, RuntimeRequest, func(Event) error) SubmitResult
	Cancel(context.Context, AttemptToken) CancelResult
	Approve(context.Context, ApprovalDecision) error
}

type Capabilities struct {
	Resume          bool
	Cancel          bool
	Approval        bool
	Attachments     bool // product bridge; Session currently clamps this to false
	PermissionModes []string
	Budget          ByteBudget
	Wrapper         HandoffWrapper
	Degraded        []string
}

func (c Capabilities) clone() Capabilities {
	c.PermissionModes = append([]string(nil), c.PermissionModes...)
	c.Degraded = append([]string(nil), c.Degraded...)
	return c
}

// Selection is reserved for history spans, so a runtime choice is Target.
// Identity and Env are non-secret metadata; capabilities never authorize a
// permission by omission. Unsupported permission modes are rejected.
type Target struct {
	Runtime       Runtime
	Identity      NativeIdentity
	Env           CompatibilityKey
	ConfirmUnsafe bool
}

type AttemptToken struct {
	ConversationID string
	AttemptID      string
	Generation     uint64
}

type RecoveryKind string

const (
	RecoveryResumed  RecoveryKind = "resumed"
	RecoveryNew      RecoveryKind = "new"
	RecoveryFallback RecoveryKind = "fallback"
	RecoveryUnknown  RecoveryKind = "unknown"
	RecoveryError    RecoveryKind = "error"
)

type RecoveryRequest struct {
	Token    AttemptToken
	Identity NativeIdentity
	Env      CompatibilityKey
	Previous Binding // empty if no confirmed compatible binding can be resumed
}

type RecoveryResult struct {
	Kind            RecoveryKind
	NativeSessionID string
	Detail          string
	// Lost is proven native-session loss (exact "thread not found") that left
	// NO usable native identity behind. The product keeps the old native
	// identity and its history, but that context is stale, so it demands an
	// explicit new native session instead of resuming it implicitly.
	Lost bool
}

type RuntimeRequest struct {
	Token           AttemptToken
	NativeSessionID string
	Plan            Plan // Send ONLY Plan.Payload, never another copy of RequestBody.
}

type SubmitKind string

const (
	SubmitAccepted SubmitKind = "submitted"
	SubmitNotSent  SubmitKind = "not-submitted" // proven pre-submit failure only
	SubmitUnknown  SubmitKind = "unknown"
)

type SubmitResult struct {
	Kind   SubmitKind
	Detail string
}

type Activity struct {
	Known            bool
	Running          bool
	Queued           int
	PendingApprovals int
	Background       int
	Subagents        int
}

func (a Activity) Idle() bool {
	return a.Known && !a.Running && a.Queued == 0 && a.PendingApprovals == 0 && a.Background == 0 && a.Subagents == 0
}

type CancelKind string

const (
	CancelStopped CancelKind = "stopped"
	CancelUnknown CancelKind = "unknown"
	CancelError   CancelKind = "error"
)

type CancelResult struct {
	Kind   CancelKind
	Work   Activity
	Detail string
}

type EventKind string

const (
	EventDelivered EventKind = "delivered"
	EventText      EventKind = "text"
	EventApproval  EventKind = "approval"
	EventCompleted EventKind = "completed"
	EventActivity  EventKind = "activity"
	EventFailed    EventKind = "failed"
)

type Event struct {
	Token           AttemptToken
	NativeSessionID string
	Kind            EventKind
	Delivery        Delivery
	Text            string // delta only; never reasoning/tool state
	ApprovalID      string
	Work            Activity // explicit quiescence evidence on completion/cancel/activity
	Detail          string
}

type ApprovalDecision struct {
	Token                       AttemptToken
	NativeSessionID, ApprovalID string
	Allow                       bool
}

type Phase string

const (
	PhaseIdle      Phase = "idle"
	PhasePreparing Phase = "preparing"
	PhaseRunning   Phase = "running"
	PhaseCompleted Phase = "completed"
	PhaseFailed    Phase = "failed-pre-submit"
	PhaseCanceling Phase = "canceling"
	PhaseCanceled  Phase = "canceled"
	PhaseUncertain Phase = "uncertain"
)

type Request struct {
	MessageID   string
	TurnID      string
	Text        string
	Attachments []string // explicitly refused, never silently dropped
	Retry       bool     // explicit user intent, never set by automatic recovery
}

type SessionState struct {
	Backend        string
	ConversationID string
	Generation     uint64
	Phase          Phase
	Token          AttemptToken
	Recovery       RecoveryResult
	Capabilities   Capabilities
	Work           Activity
	Queued         int
	Approvals      []string
	Partial        string
	Detail         string
}

var (
	ErrBusy            = errors.New("conversationruntime: not idle (turn, queue, approval, background work or unknown state)")
	ErrStaleEvent      = errors.New("conversationruntime: event/command does not own the active attempt")
	ErrPermission      = errors.New("conversationruntime: target permission capability is unsupported or unconfirmed")
	ErrAlreadyExecuted = errors.New("conversationruntime: logical request already submitted; explicit retry required or forbidden after completion")
	ErrProtocol        = errors.New("conversationruntime: runtime protocol contradiction")
)
