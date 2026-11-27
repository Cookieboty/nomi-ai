package conversationruntime

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Strategy is how the next CLI turn is prepared.
type Strategy string

const (
	// StrategyNone sends the request alone.
	StrategyNone Strategy = "none"
	// StrategyDelta hands off only the exact unseen parts of the confirmed binding.
	StrategyDelta Strategy = "delta"
	// StrategyBlocked means the binding is uncertain: the caller must resolve it
	// explicitly (start a new session) before anything is sent.
	StrategyBlocked Strategy = "blocked"
	// StrategyNewSession carries bounded full history to an explicitly new native
	// session, ignoring all coverage belonging to the previous session.
	StrategyNewSession Strategy = "new_session"
)

// Omission explains, for this attempt only, why an eligible entry is not part
// of the handoff. It is recomputed on every plan and never permanent.
type Omission struct {
	ID     string `json:"id"`
	Rev    int    `json:"rev"`
	Reason string `json:"reason"`
	// Reported means a marker fits in Payload. Unreported omissions remain
	// inspectable here and eligible next time; neither kind is delivery.
	Reported bool `json:"reported"`
}

// Selection is the exact subset of one entry revision a delta hands off:
// Ranges are sorted, half-open, rune-aligned UTF-8 runs of the text whose
// digest is Digest. A partially acknowledged revision selects only its unseen
// ranges. A selection is admitted as a whole; budget clipping never cuts text.
type Selection struct {
	ID     string      `json:"id"`
	Rev    int         `json:"rev"`
	Role   string      `json:"role"`
	Digest string      `json:"digest"`
	Ranges []ByteRange `json:"ranges"`
}

// Lineage names the ledger entry that already holds the current request (a
// retry of the same logical user message). A confirmed full delivery promotes
// it instead of re-claiming it; it is never part of the handoff.
type Lineage struct {
	ID     string
	Rev    int
	Digest string
}

// Plan is a storage-independent, inspectable handoff. Payload is the ONLY
// prompt to send: historical Handoff (if any), a newline, and RequestBody once.
// Budget bounds len(json.Marshal(Payload)), including framing and the request.
// Fields Handoff/RequestBody are diagnostics, NOT additional sends. Transport
// envelopes need their own additional bound in the eventual driver adapter.
type Plan struct {
	seal            string      // detects accidental mutation between planning and acknowledgement
	ID              string      `json:"id"`
	Strategy        Strategy    `json:"strategy"`
	BindingID       string      `json:"bindingId"`
	BindingKey      string      `json:"bindingKey"`
	NativeSessionID string      `json:"nativeSessionId,omitempty"`
	TargetRev       int         `json:"targetRevision"`
	TargetDigest    string      `json:"targetDigest"`
	Selections      []Selection `json:"selections"`
	Omitted         []Omission  `json:"omitted"`
	Handoff         string      `json:"handoff"`
	Payload         string      `json:"payload"`
	RequestBody     string      `json:"requestBody"`
	PayloadBytes    int         `json:"payloadBytes"` // len(json.Marshal(Payload))
	RequestBytes    int         `json:"requestBytes"` // len(json.Marshal(RequestBody))
	Error           string      `json:"error,omitempty"`
	Lineage         *Lineage    `json:"-"`
}

// Empty reports no selected history text. Markers and the request may remain.
func (p Plan) Empty() bool { return len(p.Selections) == 0 }

// B1Limit documents the limits of B1 in user terms.
const B1Limit = "In-memory only; no production runtime or persistence. " +
	"Selections preserve entire unseen spans, never budget-truncated. " +
	"Attachments are unsupported. Rewind is not implemented; use a new session."

// ErrBudget is returned before execution when the request itself cannot fit;
// the request is never truncated.
type ErrBudget struct {
	Need  int
	Limit int
	What  string
	Unit  string // defaults to serialized UTF-8 bytes
}

func (e *ErrBudget) Error() string {
	unit := e.Unit
	if unit == "" {
		unit = "serialized UTF-8 bytes"
	}
	return fmt.Sprintf("conversationruntime: %s is %d %s, budget is %d; "+
		"shorten or split the request before sending (never truncated)", e.What, e.Need, unit, e.Limit)
}

// PlanInput is the explicit input of the planner; nothing is read from disk,
// the environment or any credential store.
type PlanInput struct {
	// AttemptID distinguishes separate executions with identical input. Empty
	// is useful only for pure planning; production must supply an attempt ID.
	AttemptID     string
	Binding       Binding
	Identity      NativeIdentity
	Env           CompatibilityKey
	Target        RecoveryTarget
	RequestText   string
	CurrentTurnID string
	// CurrentEntryID is the stable logical ID of the request entry when it is
	// already in the ledger; this logical entry is never handed off as history.
	CurrentEntryID string
	// HistoryBeforeOrder is an explicit rewind/branch view, NEW session only.
	// Zero includes all live history except the current logical request, even
	// when that request is an older failed message being explicitly retried.
	HistoryBeforeOrder int64
	// RequestInLedger asserts RequestText is the current entry text; planning
	// then fails if the entry is missing (never a silent guess).
	RequestInLedger bool
	// HoldIDs are ledger entries kept after an explicit new-native decision
	// following RecoveryUnknown. They stay readable for Retry but are not
	// historical handoff unless they are the current request.
	HoldIDs map[string]bool
	// Attachments of the current request. B1 cannot hand them to a CLI, so any
	// attachment refuses the request before execution.
	Attachments []string
	// RequestBudget optionally raises the serialized UTF-8 byte limit for the
	// current user request above Budget while keeping historical handoff bounded
	// by Budget. Zero or <= Budget falls back to Budget.
	RequestBudget ByteBudget
	// Budget bounds json.Marshal(Plan.Payload), including the current request.
	Budget ByteBudget
	// Wrapper is the explicit transport framing of the handoff body.
	Wrapper HandoffWrapper
}

const (
	DefaultHandoffBudget       ByteBudget = 60000
	DefaultStreamRequestBudget ByteBudget = 2 * 1024 * 1024
)

func effectiveRequestBudget(handoffBudget, requestBudget ByteBudget) ByteBudget {
	if requestBudget > handoffBudget {
		return requestBudget
	}
	return handoffBudget
}

// HandoffWrapper frames handoff lines (prefix/suffix). Its serialized size is
// inside Handoff and therefore inside Budget.
type HandoffWrapper struct {
	Prefix string
	Suffix string
}

func (w HandoffWrapper) apply(body string) string {
	if body == "" {
		return ""
	}
	return w.Prefix + body + w.Suffix
}

// ByteBudget limits serialized UTF-8 JSON bytes. UTF16Budget (legacy logical
// text) and ArgvBudget (Windows command line) are distinct types so their
// units can never be added together.
type (
	ByteBudget  int
	UTF16Budget int
	ArgvBudget  int
)

func jsonLen(s string) int {
	b, err := json.Marshal(s)
	if err != nil {
		panic("conversationruntime: string marshal failed: " + err.Error())
	}
	return len(b)
}

func line(sel Selection, text string) string {
	return "[" + sel.Role + " " + sel.ID + "@" + fmt.Sprint(sel.Rev) + "] " + text
}

func omissionLine(o Omission) string {
	return "[omitted " + o.ID + "@" + fmt.Sprint(o.Rev) + " " + o.Reason + "]"
}

// CheckUTF16 reports the legacy logical size of prompt in UTF-16 code units
// against limit. Separate from every byte budget; never summed with one.
func CheckUTF16(prompt string, limit UTF16Budget) error {
	if need := UTF16Len(prompt); need > int(limit) {
		return &ErrBudget{Need: need, Limit: int(limit), What: "logical UTF-16 text", Unit: "UTF-16 code units"}
	}
	return nil
}

// UTF16QuotedLen counts one ALWAYS-QUOTED Windows CRT argv element:
// two outer quotes, doubled backslashes before an escaped quote and before
// the closing quote. This is independent of the JSON transport byte budget.
func UTF16QuotedLen(s string) int {
	n := UTF16Len(s) + 2 // Always quote the element, including its outer quotes.
	backslashes := 0
	for _, r := range s {
		switch r {
		case '\\':
			backslashes++
		case '"':
			n += backslashes + 1
			backslashes = 0
		default:
			backslashes = 0
		}
	}
	return n + backslashes
}

// CheckArgv bounds the final Windows command line (UTF-16 code units) of argv
// elements followed by prompt as its own appended argv element, including the
// inter-argument spaces and terminating NUL. It applies
// only to prompt-in-argv transports; stdin transports are bounded by
// ByteBudget instead.
func CheckArgv(prompt string, argv []string, limit ArgvBudget) error {
	need := UTF16QuotedLen(prompt) + 1
	for _, a := range argv {
		need += UTF16QuotedLen(a) + 1
	}
	if ArgvBudget(need) > limit {
		return &ErrBudget{Need: need, Limit: int(limit), What: "Windows argv", Unit: "UTF-16 code units"}
	}
	return nil
}

// CheckArgvText bounds one already-built argv element (e.g. a composed prompt)
// in UTF-16 code units, including its Windows quoting cost.
func CheckArgvText(arg string, limit ArgvBudget) error {
	if need := UTF16QuotedLen(arg); ArgvBudget(need) > limit {
		return &ErrBudget{Need: need, Limit: int(limit), What: "Windows argv element", Unit: "UTF-16 code units"}
	}
	return nil
}

// ErrInvalidUTF8 rejects text whose JSON size could not represent the
// original bytes.
var ErrInvalidUTF8 = errors.New("conversationruntime: text is not valid UTF-8")

func clonePlan(p Plan) Plan {
	p.Selections = append([]Selection(nil), p.Selections...)
	for i := range p.Selections {
		p.Selections[i].Ranges = append([]ByteRange(nil), p.Selections[i].Ranges...)
	}
	p.Omitted = append([]Omission(nil), p.Omitted...)
	if p.Lineage != nil {
		lineage := *p.Lineage
		p.Lineage = &lineage
	}
	return p
}
