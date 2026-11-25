package conversationruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Status is the native binding lifecycle. Safe reports whether the runtime may
// originate a CLI turn automatically.
type Status string

const (
	StatusLive       Status = "live"
	StatusIdle       Status = "idle"
	StatusStale      Status = "stale"   // covered content edited/rewound, or config diverged
	StatusUnknown    Status = "unknown" // execution result unknown: blocks until the caller resolves it
	StatusUnverified Status = "unverified"
)

// Safe reports whether planning may target the binding without user action.
func (s Status) Safe() bool { return s == StatusLive || s == StatusIdle }

// RevisionDigest pins a coverage claim to one exact revision text.
type RevisionDigest struct {
	Rev    int    `json:"rev"`
	Digest string `json:"digest"`
}

// Coverage records exactly what one native binding has received, per entry ID.
// Absence means "not covered": there is no high-water-mark shortcut, and a
// partial range never counts as full.
type Coverage struct {
	Delivered map[string]RevisionDigest  `json:"delivered"`
	Partial   map[string]PartialCoverage `json:"partial"`
}

// PartialCoverage is the delivered subset of revision Rev (sorted, merged
// UTF-8 byte ranges). It is never equivalent to Delivered.
type PartialCoverage struct {
	Rev    int         `json:"rev"`
	Digest string      `json:"digest"`
	Ranges []ByteRange `json:"ranges"`
}

// NewCoverage returns an empty coverage set.
func NewCoverage() Coverage {
	return Coverage{Delivered: map[string]RevisionDigest{}, Partial: map[string]PartialCoverage{}}
}

// Binding is one native session identity plus its coverage. A binding is only
// valid for one CompatibilityKey; a different key means a different binding.
// Invalidation boundaries are keyed by entry ID (the revision in which that
// entry was edited or rewound) and are consulted by Commit.
type Binding struct {
	ID               string         `json:"id"`
	CompatKey        string         `json:"compatKey"`
	NativeSessionID  string         `json:"nativeSessionId"` // immutable once set
	Status           Status         `json:"status"`
	Coverage         Coverage       `json:"coverage"`
	StaleReason      string         `json:"staleReason,omitempty"`
	InvalidatedByRev map[string]int `json:"invalidatedByRev,omitempty"`
}

// Covered reports whether rev of the exact digest counts as native state:
// delivered with that digest, or partial whose ranges cover the whole text.
func (c Coverage) Covered(id string, rev int, digest string, textLen int) bool {
	if d, ok := c.Delivered[id]; ok && d.Rev == rev && d.Digest == digest {
		return true
	}
	p, ok := c.Partial[id]
	if !ok || p.Rev != rev || p.Digest != digest {
		return false
	}
	rs, err := normalizeRanges(p.Ranges, textLen)
	return err == nil && textLen > 0 && len(rs) == 1 && rs[0] == (ByteRange{0, textLen})
}

func (b Binding) clone() Binding {
	c := b
	c.Coverage = NewCoverage()
	for k, v := range b.Coverage.Delivered {
		c.Coverage.Delivered[k] = v
	}
	for k, v := range b.Coverage.Partial {
		v.Ranges = append([]ByteRange(nil), v.Ranges...)
		c.Coverage.Partial[k] = v
	}
	c.InvalidatedByRev = copyRevMap(b.InvalidatedByRev)
	return c
}

func copyRevMap(m map[string]int) map[string]int {
	if m == nil {
		return nil
	}
	out := make(map[string]int, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// RecoveryTarget is what the caller has resolved the next turn to.
type RecoveryTarget int

const (
	// TargetCurrent reuses the given binding when it is compatible, live/idle
	// and its native identity matches; otherwise planning blocks.
	TargetCurrent RecoveryTarget = iota
	// TargetNew always starts a fresh, empty-coverage binding.
	TargetNew
	// TargetResume continues the given binding or refuses; it never falls back.
	TargetResume
)

// NativeIdentity is caller-supplied, non-secret identity of a launch. No field
// may hold credentials.
type NativeIdentity struct {
	DriverID          string `json:"driverId"`
	Transport         string `json:"transport"`
	DriverVersion     string `json:"driverVersion"`
	ResumeProtocol    string `json:"resumeProtocol"`
	Executable        string `json:"executable"`
	ExecutableSize    int64  `json:"executableSize"`
	ExecutableMtimeMS int64  `json:"executableMtimeMs"`
	Source            string `json:"source"`
	AccountID         string `json:"accountId"`
	ConfigDir         string `json:"configDir"`
	ConfigGen         int64  `json:"configGeneration"`
	Cwd               string `json:"cwd"`
	LaunchFingerprint string `json:"launchFingerprint"`
}

// CompatibilityKey are the non-secret, resume-sensitive turn parameters that
// are not part of the launch identity.
type CompatibilityKey struct {
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	PermissionMode string `json:"permissionMode"`
}

const compatSchema = "cr-compat-2"

// Key is the canonical compatibility digest. An incomplete identity never
// equals a complete one (missing fields are marked).
func (id NativeIdentity) Key(env CompatibilityKey) string {
	// Structured encoding avoids delimiter collisions in caller-supplied paths.
	encoded, _ := json.Marshal(struct {
		Schema      string
		Identity    NativeIdentity
		Environment CompatibilityKey
	}{compatSchema, id, env})
	sum := sha256.Sum256(encoded)
	return "k2:" + hex.EncodeToString(sum[:])
}

var (
	ErrStaleBinding    = errors.New("conversationruntime: binding incompatible with target identity")
	ErrUnknownState    = errors.New("conversationruntime: binding state unknown; caller must resolve")
	ErrStalePlan       = errors.New("conversationruntime: plan is stale or does not match the binding")
	ErrPlanMismatch    = errors.New("conversationruntime: delivery does not match plan")
	ErrUnconfirmed     = errors.New("conversationruntime: delivery not confirmed; coverage unchanged")
	ErrNoCoverage      = errors.New("conversationruntime: delivery claims no planned content")
	ErrNoSuchBinding   = errors.New("conversationruntime: no such binding")
	ErrDuplicateBindID = errors.New("conversationruntime: binding id already exists")
)

// BindingStore holds bindings in memory. Invalidation never deletes a binding.
type BindingStore struct {
	mu sync.Mutex
	b  map[string]Binding
}

// NewBindingStore returns an empty store.
func NewBindingStore() *BindingStore { return &BindingStore{b: map[string]Binding{}} }

// Put stores a new binding. An existing ID is never overwritten: a new native
// session or identity must be stored under a new binding ID (ErrDuplicateBindID
// otherwise). The stored record does not alias the caller's maps or slices.
func (s *BindingStore) Put(b Binding) error {
	if strings.TrimSpace(b.ID) == "" {
		return fmt.Errorf("%w: empty id", ErrBadEdit)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.b[b.ID]; ok {
		return fmt.Errorf("%w: %q", ErrDuplicateBindID, b.ID)
	}
	s.b[b.ID] = b.clone()
	return nil
}

// Get returns a deep copy of the binding.
func (s *BindingStore) Get(id string) (Binding, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.b[id]
	return b.clone(), ok
}

// All returns deep copies of all bindings sorted by ID.
func (s *BindingStore) All() []Binding {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.allLocked()
}

func (s *BindingStore) allLocked() []Binding {
	out := make([]Binding, 0, len(s.b))
	for _, b := range s.b {
		out = append(out, b.clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
