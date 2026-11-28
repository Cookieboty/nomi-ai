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

// SwitchAwareRuntime may be implemented by runtimes that participate in
// transactional target preparation or teardown without dispatching user turns.
type SwitchAwareRuntime interface {
	PrepareSwitch(context.Context) error
	Teardown(context.Context) error
}

type SwitchOutcome struct {
	FromBackend      string   `json:"fromBackend"`
	ToBackend        string   `json:"toBackend"`
	ExpectedStrategy Strategy `json:"expectedStrategy"`
	PlannedEntries   int      `json:"plannedEntries"`
	OmittedEntries   int      `json:"omittedEntries"`
	ResumableBinding string   `json:"resumableBinding,omitempty"`
}

type BridgeState struct {
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type CapabilityBridges struct {
	Computer    BridgeState `json:"computer"`
	MCP         BridgeState `json:"mcp"`
	Persona     BridgeState `json:"persona"`
	Memory      BridgeState `json:"memory"`
	Knowledge   BridgeState `json:"knowledge"`
	Skills      BridgeState `json:"skills"`
	Attachments BridgeState `json:"attachments"`
}

type Capabilities struct {
	Resume          bool
	Cancel          bool
	Approval        bool
	Attachments     bool
	PermissionModes []string
	Budget          ByteBudget
	RequestBudget   ByteBudget `json:"requestBudget,omitempty"`
	Wrapper         HandoffWrapper
	Degraded        []string
	Bridges         *CapabilityBridges `json:"bridges,omitempty"`
}

func (c Capabilities) clone() Capabilities {
	c.PermissionModes = append([]string(nil), c.PermissionModes...)
	c.Degraded = append([]string(nil), c.Degraded...)
	if c.Bridges != nil {
		b := *c.Bridges
		c.Bridges = &b
	}
	return c
}

// Selection is reserved for history spans, so a runtime choice is Target.
// Identity and Env are non-secret metadata; capabilities never authorize a
// permission by omission. Unsupported permission modes are rejected.
type Target struct {
	Runtime       Runtime
	Identity      NativeIdentity
	Env           CompatibilityKey
	Effort        string
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
	Images          []string
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
	EventStream    EventKind = "stream"
	EventText      EventKind = "text"
	EventApproval  EventKind = "approval"
	EventTrace     EventKind = "trace"
	EventContext   EventKind = "context"
	EventMeta      EventKind = "meta"
	EventCompleted EventKind = "completed"
	EventActivity  EventKind = "activity"
	EventFailed    EventKind = "failed"
)

type ApprovalOption struct {
	ID   string `json:"id"`
	Kind string `json:"kind,omitempty"`
	Name string `json:"name,omitempty"`
}

type ApprovalInfo struct {
	ID          string           `json:"id"`
	Kind        string           `json:"kind,omitempty"`
	Tool        string           `json:"tool,omitempty"`
	Summary     string           `json:"summary,omitempty"`
	ArgsPreview string           `json:"argsPreview,omitempty"`
	Danger      string           `json:"danger,omitempty"`
	Risk        string           `json:"risk,omitempty"`
	Rationale   string           `json:"rationale,omitempty"`
	Options     []ApprovalOption `json:"options,omitempty"`
}

type RuntimeStatus struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

type RuntimeNotice struct {
	Tag  string `json:"tag"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

type SlashCommandInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Hint        string `json:"hint,omitempty"`
}

type TraceEntry struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Tool    string `json:"tool,omitempty"`
	Summary string `json:"summary,omitempty"`
	Status  string `json:"status,omitempty"`
	Detail  string `json:"detail,omitempty"`
	Output  string `json:"output,omitempty"`
	At      int64  `json:"at"`
	EndedAt int64  `json:"endedAt,omitempty"`
	TextAt  *int   `json:"textAt,omitempty"`
}

// TurnUsage holds non-authoritative turn token/context/cost metrics attached on completion.
type TurnUsage struct {
	InputTokens      *int64   `json:"inputTokens,omitempty"`
	OutputTokens     *int64   `json:"outputTokens,omitempty"`
	CacheReadTokens  *int64   `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens *int64   `json:"cacheWriteTokens,omitempty"`
	ThoughtTokens    *int64   `json:"thoughtTokens,omitempty"`
	TotalTokens      *int64   `json:"totalTokens,omitempty"`
	ContextTokens    *int64   `json:"contextTokens,omitempty"`
	ContextWindow    *int64   `json:"contextWindow,omitempty"`
	CostUsd          *float64 `json:"costUsd,omitempty"`
	DurationMs       *int64   `json:"durationMs,omitempty"`
}

func cloneInt64Ptr(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneFloat64Ptr(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneTurnUsage(u *TurnUsage) *TurnUsage {
	if u == nil {
		return nil
	}
	return &TurnUsage{
		InputTokens:      cloneInt64Ptr(u.InputTokens),
		OutputTokens:     cloneInt64Ptr(u.OutputTokens),
		CacheReadTokens:  cloneInt64Ptr(u.CacheReadTokens),
		CacheWriteTokens: cloneInt64Ptr(u.CacheWriteTokens),
		ThoughtTokens:    cloneInt64Ptr(u.ThoughtTokens),
		TotalTokens:      cloneInt64Ptr(u.TotalTokens),
		ContextTokens:    cloneInt64Ptr(u.ContextTokens),
		ContextWindow:    cloneInt64Ptr(u.ContextWindow),
		CostUsd:          cloneFloat64Ptr(u.CostUsd),
		DurationMs:       cloneInt64Ptr(u.DurationMs),
	}
}

func cloneTraceEntries(in []TraceEntry) []TraceEntry {
	if len(in) == 0 {
		return nil
	}
	out := make([]TraceEntry, len(in))
	for i, e := range in {
		out[i] = e
		if e.TextAt != nil {
			v := *e.TextAt
			out[i].TextAt = &v
		}
	}
	return out
}

type Event struct {
	Token           AttemptToken
	NativeSessionID string
	Kind            EventKind
	Delivery        Delivery
	Text            string // delta only; never reasoning/tool state
	Thinking        string // non-authoritative streaming delta only (EventStream)
	ThinkingActive  bool
	ApprovalID      string
	ApprovalInfo    *ApprovalInfo
	Trace           *TraceEntry
	ContextTokens   *int64
	ContextWindow   *int64
	CostUsd         *float64
	Status          *RuntimeStatus
	Notice          *RuntimeNotice
	Commands        []SlashCommandInfo
	Work            Activity // explicit quiescence evidence on completion/cancel/activity
	Detail          string
	Model           string
	Effort          string
	ResponseModel   string
	DurationMs      int64
	Usage           *TurnUsage
}

type ApprovalDecision struct {
	Token                       AttemptToken
	NativeSessionID, ApprovalID string
	Allow                       bool
	OptionID                    string
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
	MessageID   string   `json:"messageId"`
	TurnID      string   `json:"turnId"`
	Text        string   `json:"text"`
	Attachments []string `json:"attachments,omitempty"` // explicitly refused when backend lacks attachment support
	Images      []string `json:"images,omitempty"`
	Retry       bool     `json:"retry,omitempty"` // explicit user intent, never set by automatic recovery
}

type SessionState struct {
	Backend         string
	Source          string `json:"source,omitempty"`
	ConversationID  string
	Generation      uint64
	Phase           Phase
	Token           AttemptToken
	Recovery        RecoveryResult
	Capabilities    Capabilities
	Work            Activity
	Queued          int
	Approvals       []string
	ApprovalDetails []ApprovalInfo `json:"approvalDetails,omitempty"`
	Trace           []TraceEntry   `json:"trace,omitempty"`
	FailedRequest   *Request       `json:"failedRequest,omitempty"`
	Model           string         `json:"model,omitempty"`
	AccountID       string         `json:"accountId,omitempty"`
	PermissionMode  string         `json:"permissionMode,omitempty"`
	Effort          string         `json:"effort,omitempty"`
	Partial         string
	Thinking        string             `json:"thinking,omitempty"`
	ThinkingActive  bool               `json:"thinkingActive,omitempty"`
	ContextTokens   *int64             `json:"contextTokens,omitempty"`
	ContextWindow   *int64             `json:"contextWindow,omitempty"`
	Status          *RuntimeStatus     `json:"status,omitempty"`
	Notice          *RuntimeNotice     `json:"notice,omitempty"`
	Commands        []SlashCommandInfo `json:"commands,omitempty"`
	Detail          string
	PendingSwitch   *SwitchState       `json:"pendingSwitch,omitempty"`
	LastSwitch      *LastSwitchSummary `json:"lastSwitch,omitempty"`
}

var (
	ErrBusy            = errors.New("conversationruntime: not idle (turn, queue, approval, background work or unknown state)")
	ErrStaleEvent      = errors.New("conversationruntime: event/command does not own the active attempt")
	ErrPermission      = errors.New("conversationruntime: target permission capability is unsupported or unconfirmed")
	ErrAlreadyExecuted = errors.New("conversationruntime: logical request already submitted; explicit retry required or forbidden after completion")
	ErrProtocol        = errors.New("conversationruntime: runtime protocol contradiction")
)
