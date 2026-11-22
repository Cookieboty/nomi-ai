// Package conversationruntime is the B1, storage-independent core of a
// conversation-scoped CLI runtime: a revision ledger with stable logical IDs,
// per-native-binding delivery coverage, a pure compatibility key and a bounded
// full/delta handoff planner.
//
// It is pure Go (stdlib only): no file system, no environment probes, no
// credentials, no CLI processes, no persistence. Callers supply every input
// explicitly. Not wired production code; experimental until the gates in
// docs/design/2.5.0-main-chat-cli-runtime.md §12/§17 are met.
package conversationruntime

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// Entry is one revision record of a logical message. ID is stable across
// revisions, Order never changes, older revisions stay readable. A tombstone
// is a later revision with Tombstone set that keeps Order; old text remains
// readable in older revisions for audit, not in the current projection.
//
// Attachments are declared, never part of handoff text: any entry that has
// Attachments is omitted with ReasonAttachment. Lists are never shared with
// callers (defensive copies on ingest and on read).
type Entry struct {
	Raw         []byte   `json:"raw,omitempty"` // exact legacy payload retained, never transferred to CLI
	ID          string   `json:"id"`
	Revision    int      `json:"revision"`
	Order       int64    `json:"order"`
	TurnID      string   `json:"turnId"`
	Role        string   `json:"role"` // "user" or "assistant"
	Origin      string   `json:"origin"`
	Text        string   `json:"text"`
	Attachments []string `json:"attachments,omitempty"`
	Tombstone   bool     `json:"tombstone,omitempty"`
}

const (
	// ReasonBudget marks a candidate the assembled payload had no room for.
	// It is recomputed every plan and never sticks.
	ReasonBudget = "budget"
	// ReasonAttachment marks history with attachments: never absorbed.
	ReasonAttachment = "attachment"
	// ReasonEntryTooLarge marks one text entry larger than the remaining
	// payload room; selection is whole-entry only (see Plan).
	ReasonEntryTooLarge = "entry-too-large"
)

var (
	// ErrDuplicateRevision is returned when (id, revision) already exists.
	ErrDuplicateRevision = errors.New("conversationruntime: (id, revision) already recorded")
	// ErrDuplicateID is returned when Append reuses an existing logical ID.
	ErrDuplicateID = errors.New("conversationruntime: duplicate logical id (use Edit or Tombstone)")
	// ErrUnknownEntry is returned when the entry (or revision) does not exist.
	ErrUnknownEntry = errors.New("conversationruntime: entry not found")
	// ErrBadEdit is returned for an invalid record (empty ID/role/text...).
	ErrBadEdit = errors.New("conversationruntime: invalid entry")
)

// Ledger is an append-only revision log; within this package it is the only
// writer of entry records. It is safe for concurrent use.
type Ledger struct {
	mu      sync.Mutex
	next    int64
	order   []string // logical IDs in first-append order
	latest  map[string]Entry
	history map[string]map[int]Entry
	// committed maps plan ID -> receipt digest of the attempt that was
	// committed, for idempotent repeats (guarded by the store lock, see Commit).
	committed map[string]string
}

// NewLedger returns an empty ledger.
func NewLedger() *Ledger {
	return &Ledger{next: 1, latest: map[string]Entry{}, history: map[string]map[int]Entry{}, committed: map[string]string{}}
}

// Append records revision 1 of a new logical message and returns the stored
// entry (with Order assigned).
func (l *Ledger) Append(e Entry) (Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if strings.TrimSpace(e.ID) == "" {
		return Entry{}, fmt.Errorf("%w: empty id", ErrBadEdit)
	}
	switch e.Role {
	case "user", "assistant":
	default:
		return Entry{}, fmt.Errorf("%w: role %q", ErrBadEdit, e.Role)
	}
	if _, ok := l.latest[e.ID]; ok {
		return Entry{}, fmt.Errorf("%w: %q", ErrDuplicateID, e.ID)
	}
	if !utf8OK(e.Text) || !utf8OK(e.ID) {
		return Entry{}, ErrInvalidUTF8
	}
	e.Revision = 1
	e.Order = l.next
	l.next++
	l.put(e)
	return copyEntry(e), nil
}

func (l *Ledger) put(e Entry) {
	h, ok := l.history[e.ID]
	if !ok {
		h = map[int]Entry{}
		l.history[e.ID] = h
		l.order = append(l.order, e.ID)
	}
	if _, dup := h[e.Revision]; dup {
		panic("conversationruntime: internal duplicate revision")
	}
	e = copyEntry(e)
	h[e.Revision] = e
	l.latest[e.ID] = e
}

// Latest returns the latest stored revision of id (which may be a tombstone).
func (l *Ledger) Latest(id string) (Entry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.latest[id]
	return copyEntry(e), ok
}

// Revision returns exactly (id, revision), if it was recorded.
func (l *Ledger) Revision(id string, revision int) (Entry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.history[id][revision]
	return copyEntry(e), ok
}

// Snapshot returns every latest revision in first-append order.
func (l *Ledger) Snapshot() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Entry, 0, len(l.order))
	for _, id := range l.order {
		out = append(out, copyEntry(l.latest[id]))
	}
	return out
}

// Len reports the number of logical messages (tombstones included).
func (l *Ledger) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.order)
}

func copyEntry(e Entry) Entry {
	e.Raw = append([]byte(nil), e.Raw...)
	if e.Attachments != nil {
		e.Attachments = append([]string(nil), e.Attachments...)
	}
	return e
}
