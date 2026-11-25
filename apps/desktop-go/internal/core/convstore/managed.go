package convstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

const managedVersion = 2
const maxManagedBytes = 256 << 20

var ErrManagedCorrupt = errors.New("managed authority corrupt or unsupported; refusing legacy fallback")
var ErrManagedConflict = errors.New("managed authority version conflict; reopen required")

type LegacyArchive struct {
	Index, Meta, Messages, Staging []byte
	SourceDigest                   string
}
type ManagedDocument struct {
	Deleted  bool `json:"Deleted,omitempty"`
	Version  int
	Sequence uint64
	Meta     []byte
	State    cr.Checkpoint
	Legacy   LegacyArchive
	Mappings []IDMapping
	Checksum string
}

func (s *Store) managedPath(id string) string { return filepath.Join(s.dir, "managed-v2", id+".json") }
func documentSum(d ManagedDocument) string {
	d.Checksum = ""
	b, _ := json.Marshal(d)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func readManaged(path string) (ManagedDocument, error) {
	b, err := readRegularBounded(path, maxManagedBytes)
	if errors.Is(err, ErrMigrationBlocked) {
		return ManagedDocument{}, fmt.Errorf("%w: %v", ErrManagedCorrupt, err)
	}
	if err != nil {
		return ManagedDocument{}, err
	}
	var d ManagedDocument
	if json.Unmarshal(b, &d) != nil || d.Version != managedVersion || d.Sequence == 0 || d.Checksum != documentSum(d) {
		return d, ErrManagedCorrupt
	}
	if _, id, err := normMeta(d.Meta, d.State.ConversationID); err != nil || id != d.State.ConversationID {
		return d, ErrManagedCorrupt
	}
	if err = cr.ValidateCheckpoint(d.State); err != nil {
		return d, fmt.Errorf("%w: %v", ErrManagedCorrupt, err)
	}
	if filepath.Base(path) != d.State.ConversationID+".json" {
		return d, ErrManagedCorrupt
	}
	return d, nil
}

// ManagedLease is the only writer for one v2 conversation. Closing it revokes
// writes from the old in-memory Session; another process may then recover.
type ManagedLease struct {
	mu           sync.Mutex
	store        *Store
	id           string
	sequence     uint64
	unlock       func()
	closed       bool
	sessionBound bool
	ops          managedIO
}

func (s *Store) OpenManaged(id string) (*ManagedLease, error) {
	if !ValidID(id) {
		return nil, ErrBadID
	}
	unlock, err := lockPath(filepath.Join(s.dir, "managed-v2", id+".lock"))
	if err != nil {
		return nil, err
	}
	done, err := s.lockStore()
	if err != nil {
		unlock()
		return nil, err
	}
	defer done()
	d, err := readManaged(s.managedPath(id))
	if err != nil {
		unlock()
		return nil, err
	}
	if d.Deleted {
		unlock()
		return nil, ErrNotFound
	}
	return &ManagedLease{store: s, id: id, sequence: d.Sequence, unlock: unlock, ops: defaultManagedIO()}, nil
}
func (l *ManagedLease) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		l.unlock()
	}
	return nil
}
func (l *ManagedLease) Commit(state cr.Checkpoint) error { return l.commit(state, false) }
func (l *ManagedLease) Retire(state cr.Checkpoint) error { return l.commit(state, true) }
func (l *ManagedLease) commit(state cr.Checkpoint, deleted bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrManagedConflict
	}
	if state.ConversationID != l.id {
		return ErrBadID
	}
	if err := cr.ValidateCheckpoint(state); err != nil {
		return err
	}
	done, err := l.store.lockStore()
	if err != nil {
		return err
	}
	defer done()
	old, err := readManaged(l.store.managedPath(l.id))
	if err != nil {
		return err
	}
	if old.Deleted {
		return ErrNotFound
	}
	if old.Sequence != l.sequence || old.Sequence == ^uint64(0) {
		return ErrManagedConflict
	}
	if !compatibleSuccessor(old.State, state) {
		return ErrManagedConflict
	}
	if state.Generation < old.State.Generation {
		return ErrManagedConflict
	}
	old.Sequence++
	old.State = state
	old.Deleted = deleted
	old.Checksum = documentSum(old)
	b, err := json.Marshal(old)
	if err != nil {
		return err
	}
	if err = atomicManaged(l.store.managedPath(l.id), b, l.ops); err != nil {
		return err
	}
	l.sequence = old.Sequence
	return nil
}

// UpdateMeta atomically updates controlled sidebar metadata fields on a leased managed document
// while keeping identity fields (id, createdAt, backend, projectId) and runtime state immutable.
func (l *ManagedLease) UpdateMeta(fn func(meta map[string]any) bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return ErrManagedConflict
	}
	if fn == nil {
		return nil
	}
	done, err := l.store.lockStore()
	if err != nil {
		return err
	}
	defer done()
	old, err := readManaged(l.store.managedPath(l.id))
	if err != nil {
		return err
	}
	if old.Deleted {
		return ErrNotFound
	}
	if old.Sequence != l.sequence || old.Sequence == ^uint64(0) {
		return ErrManagedConflict
	}
	var meta map[string]any
	dec := json.NewDecoder(bytes.NewReader(old.Meta))
	dec.UseNumber()
	if err = dec.Decode(&meta); err != nil || meta == nil {
		return ErrManagedCorrupt
	}
	origCreatedAt, hasCreatedAt := meta["createdAt"]
	origBackend, hasBackend := meta["backend"]
	origProjectID, hasProjectID := meta["projectId"]
	if !fn(meta) {
		return nil
	}
	meta["id"] = l.id
	if hasCreatedAt {
		meta["createdAt"] = origCreatedAt
	} else {
		delete(meta, "createdAt")
	}
	if hasBackend {
		meta["backend"] = origBackend
	} else {
		delete(meta, "backend")
	}
	if hasProjectID {
		meta["projectId"] = origProjectID
	} else {
		delete(meta, "projectId")
	}
	b, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	norm, normID, err := normMeta(b, l.id)
	if err != nil {
		return err
	}
	if normID != l.id {
		return ErrBadID
	}
	old.Sequence++
	old.Meta = norm
	old.Checksum = documentSum(old)
	docBytes, err := json.Marshal(old)
	if err != nil {
		return err
	}
	if err = atomicManaged(l.store.managedPath(l.id), docBytes, l.ops); err != nil {
		return err
	}
	l.sequence = old.Sequence
	return nil
}
func (l *ManagedLease) Session() (*cr.Session, error) {
	l.mu.Lock()
	if l.closed || l.sessionBound {
		l.mu.Unlock()
		return nil, ErrManagedConflict
	}
	l.sessionBound = true
	d, err := readManaged(l.store.managedPath(l.id))
	l.mu.Unlock()
	if err != nil {
		return nil, err
	}
	c, err := cr.RestoreCheckpoint(d.State)
	if err != nil {
		return nil, err
	}
	if err = c.AttachCommitter(l); err != nil {
		return nil, err
	}
	return c, nil
}
func (s *Store) ReadManaged(id string) (ManagedDocument, error) {
	if !ValidID(id) {
		return ManagedDocument{}, ErrBadID
	}
	done, err := s.lockStore()
	if err != nil {
		return ManagedDocument{}, err
	}
	defer done()
	return readManaged(s.managedPath(id))
}

// This is a trusted actor sink, never a UI/IPC state replacement endpoint.
// Preserve immutable audit revisions and binding identities even on a bad
// coordinator call. Event/receipt authentication is Session's responsibility.
func compatibleSuccessor(old, next cr.Checkpoint) bool {
	revisions := map[string]map[int]cr.Entry{}
	for _, e := range next.History {
		if revisions[e.ID] == nil {
			revisions[e.ID] = map[int]cr.Entry{}
		}
		revisions[e.ID][e.Revision] = e
	}
	for _, e := range old.History {
		n, ok := revisions[e.ID][e.Revision]
		if !ok || !reflect.DeepEqual(e, n) {
			return false
		}
	}
	bindings := map[string]cr.Binding{}
	for _, b := range next.Bindings {
		bindings[b.ID] = b
	}
	for _, b := range old.Bindings {
		n, ok := bindings[b.ID]
		if !ok || n.CompatKey != b.CompatKey || (b.NativeSessionID != "" && b.NativeSessionID != n.NativeSessionID) {
			return false
		}
	}
	for id, rev := range old.Completed {
		if next.Completed[id] < rev {
			return false
		}
	}
	for id, receipt := range old.Receipts {
		if next.Receipts[id] != receipt {
			return false
		}
	}
	for id, yes := range old.Attempted {
		if yes && !next.Attempted[id] {
			return false
		}
	}
	return true
}

func (s *Store) IsManaged(id string) bool {
	if !ValidID(id) {
		return false
	}
	return s.legacyWritable(id) != nil
}
