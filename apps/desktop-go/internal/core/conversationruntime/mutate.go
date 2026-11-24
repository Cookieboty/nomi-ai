package conversationruntime

import (
	"errors"
	"fmt"
)

// Edit atomically edits one entry (revision + 1) and invalidates, by ENTRY ID
// and the edit's revision, every binding that claims a delivery of an older
// revision of that entry (full or partial). The claim is dropped because it no
// longer describes native state, and the boundary makes any plan built before
// the edit stale at Commit (KeyedRef had planned Delivered OR Partial of an old
// revision). The store lock is held across the ledger write, so a concurrent
// Commit either fully precedes the edit (and is invalidated here) or sees the
// new revision and fails as stale. Store lock -> ledger lock, same as Commit.
func (l *Ledger) Edit(store *BindingStore, id, text string) (Entry, error) {
	if l == nil || store == nil {
		return Entry{}, errors.New("conversationruntime: nil ledger or store")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, ok := l.latest[id]
	if !ok {
		return Entry{}, fmt.Errorf("%w: %q", ErrUnknownEntry, id)
	}
	if cur.Tombstone {
		return Entry{}, fmt.Errorf("%w: %q is tombstoned", ErrBadEdit, id)
	}
	if !utf8OK(text) {
		return Entry{}, ErrInvalidUTF8
	}
	next := copyEntry(cur)
	next.Text = text
	next.Revision = cur.Revision + 1
	invalidateClaims(store, id, next.Revision)
	l.put(next)
	return copyEntry(next), nil
}

// Delete appends a tombstone revision and invalidates bindings that claim the
// deleted entry. The tombstone carries no text: a deleted entry is never
// handed off again in current history. Older revisions remain available for audit.
func (l *Ledger) Delete(store *BindingStore, id string) (Entry, error) {
	if l == nil || store == nil {
		return Entry{}, errors.New("conversationruntime: nil ledger or store")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, ok := l.latest[id]
	if !ok {
		return Entry{}, fmt.Errorf("%w: %q", ErrUnknownEntry, id)
	}
	if cur.Tombstone {
		return Entry{}, fmt.Errorf("%w: %q is already tombstoned", ErrBadEdit, id)
	}
	next := copyEntry(cur)
	next.Text = ""
	next.Tombstone = true
	next.Revision = cur.Revision + 1
	invalidateClaims(store, id, next.Revision)
	l.put(next)
	return copyEntry(next), nil
}

// Rewind atomically tombstones fromID and every subsequent live entry in product
// order, invalidating bindings that claimed delivered history of any removed entry.
func (l *Ledger) Rewind(store *BindingStore, fromID string) ([]Entry, error) {
	if l == nil || store == nil {
		return nil, errors.New("conversationruntime: nil ledger or store")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, ok := l.latest[fromID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownEntry, fromID)
	}
	if cur.Tombstone {
		return nil, fmt.Errorf("%w: %q is already tombstoned", ErrBadEdit, fromID)
	}
	if cur.Role != "user" {
		return nil, fmt.Errorf("%w: rewind target %q must be a user entry", ErrBadEdit, fromID)
	}
	var removed []Entry
	for _, id := range l.order {
		e := l.latest[id]
		if e.Order < cur.Order || e.Tombstone {
			continue
		}
		next := copyEntry(e)
		next.Text = ""
		next.Tombstone = true
		next.Revision = e.Revision + 1
		invalidateClaims(store, e.ID, next.Revision)
		l.put(next)
		removed = append(removed, copyEntry(next))
	}
	return removed, nil
}

// invalidateClaims drops covered claims of entry id older than rev, marks
// native state stale when affected, and records a boundary for all outstanding
// plans. The store lock must be held.
func invalidateClaims(store *BindingStore, id string, rev int) {
	for bid, b := range store.b {
		hit := false
		if d, ok := b.Coverage.Delivered[id]; ok && d.Rev < rev {
			delete(b.Coverage.Delivered, id)
			hit = true
		}
		if p, ok := b.Coverage.Partial[id]; ok && p.Rev < rev {
			delete(b.Coverage.Partial, id)
			hit = true
		}
		if hit {
			b.Status, b.StaleReason = StatusStale, "delivered history edited or deleted"
		}
		if b.InvalidatedByRev == nil {
			b.InvalidatedByRev = map[string]int{}
		}
		b.InvalidatedByRev[id] = rev
		store.b[bid] = b
	}
}
