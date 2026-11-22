// Package mainchat owns the application ingress for opted-in product chats.
// Factories are metadata-only; user turns run solely through leased Sessions.
package mainchat

import (
	"context"
	"errors"
	"sort"
	"sync"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
)

var ErrUnavailable = errors.New("managed runtime unavailable")
var ErrClosed = errors.New("main chat registry closed")

type Factory func(conversationID string) (cr.Target, error)
type actor struct {
	session *cr.Session
	lease   *convstore.ManagedLease
	ctx     context.Context
	cancel  context.CancelFunc
}
type Registry struct {
	mu        sync.Mutex
	store     *convstore.Store
	factories map[string]Factory
	actors    map[string]*actor
	closed    bool
	notify    func(string)
	releases  map[string]func(string)
	releasing map[string]chan struct{}
}

func New(s *convstore.Store, notify func(string)) *Registry {
	return &Registry{store: s, factories: map[string]Factory{}, actors: map[string]*actor{}, notify: notify, releases: map[string]func(string){}, releasing: map[string]chan struct{}{}}
}
func (r *Registry) Register(name string, f Factory) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed && f != nil {
		r.factories[name] = f
	}
}

// RegisterOwned releases cached native processes even when another backend is
// currently selected. The callback runs outside registry/session locks.
func (r *Registry) RegisterOwned(name string, f Factory, release func(string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed && f != nil {
		r.factories[name] = f
		r.releases[name] = release
	}
}
func (r *Registry) Available() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	if !r.closed && convstore.ManagedSupported() {
		for name := range r.factories {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}
func (r *Registry) target(id, name string) (cr.Target, error) {
	r.mu.Lock()
	f := r.factories[name]
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return cr.Target{}, ErrClosed
	}
	if f == nil {
		return cr.Target{}, ErrUnavailable
	}
	t, err := f(id)
	if err != nil {
		return t, err
	}
	if t.Identity.DriverID != name || t.Runtime == nil {
		return t, cr.ErrBadEdit
	}
	t.Runtime = &observedRuntime{Runtime: t.Runtime, notify: func() { r.changed(id) }}
	return t, nil
}
func (r *Registry) changed(id string) {
	if r.notify != nil {
		r.notify(id)
	}
}
func (r *Registry) get(id string) (*actor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, ErrClosed
	}
	if r.releasing[id] != nil {
		return nil, ErrUnavailable
	}
	if a := r.actors[id]; a != nil {
		return a, nil
	}
	if !convstore.ManagedSupported() {
		return nil, convstore.ErrDurabilityUnsupported
	}
	l, err := r.store.OpenManaged(id)
	if err != nil {
		return nil, err
	}
	c, err := l.Session()
	if err != nil {
		_ = l.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &actor{session: c, lease: l, ctx: ctx, cancel: cancel}
	r.actors[id] = a
	return a, nil
}

// Adopt must be explicitly confirmed and must resolve a supported target BEFORE
// publishing ownership. In particular Windows and missing CLIs cannot adopt.
func (r *Registry) Adopt(id, name string, confirm bool) error {
	if !confirm {
		return cr.ErrPermission
	}
	if !convstore.ManagedSupported() {
		return convstore.ErrDurabilityUnsupported
	}
	t, err := r.target(id, name)
	if err != nil {
		return err
	}
	// Validate metadata/permissions without executing or migrating anything.
	probe, _ := cr.NewSession(id, nil)
	if err = probe.Select(t); err != nil {
		return err
	}
	if _, err = r.store.AdoptManaged(id); err != nil {
		return err
	}
	a, err := r.get(id)
	if err != nil {
		return err
	}
	t, err = r.target(id, name)
	if err != nil {
		return err
	}
	if err = a.session.Select(t); err != nil {
		return err
	}
	r.changed(id)
	return nil
}
func (r *Registry) Select(id, name string) error {
	a, err := r.get(id)
	if err != nil {
		return err
	}
	t, err := r.target(id, name)
	if err != nil {
		return err
	}
	err = a.session.Select(t)
	r.changed(id)
	return err
}
func (r *Registry) State(id string) (cr.SessionState, error) {
	a, err := r.get(id)
	if err != nil {
		return cr.SessionState{}, err
	}
	return a.session.State(), nil
}
func (r *Registry) Send(ctx context.Context, id string, request cr.Request, expected uint64) (cr.AttemptToken, error) {
	if ctx == nil || ctx.Err() != nil {
		return cr.AttemptToken{}, cr.ErrBadEdit
	}
	a, err := r.get(id)
	if err != nil {
		return cr.AttemptToken{}, err
	}
	// A response finishing does not cancel an accepted asynchronous turn.
	t, e := r.target(id, a.session.Checkpoint().Selected.Identity.DriverID)
	if e != nil {
		return cr.AttemptToken{}, e
	}
	selected := a.session.Checkpoint().Selected
	if selected.Identity.Key(selected.Env) != t.Identity.Key(t.Env) {
		return cr.AttemptToken{}, cr.ErrStaleBinding
	}
	if a.session.NeedsRuntime() {
		if e = a.session.Reattach(t); e != nil {
			return cr.AttemptToken{}, e
		}
	}

	token, err := a.session.StartAt(a.ctx, request, expected)
	r.changed(id)
	return token, err
}
func (r *Registry) Cancel(ctx context.Context, id string) (cr.CancelResult, error) {
	a, err := r.get(id)
	if err != nil {
		return cr.CancelResult{}, err
	}
	name := a.session.Checkpoint().Selected.Identity.DriverID
	if a.session.NeedsRuntime() {
		t, e := r.target(id, name)
		if e != nil {
			return cr.CancelResult{}, e
		}
		if e = a.session.Reattach(t); e != nil {
			return cr.CancelResult{}, e
		}
	}
	result, err := a.session.Cancel(ctx)
	r.changed(id)
	return result, err
}
func (r *Registry) Approve(ctx context.Context, id string, token cr.AttemptToken, approval string, allow bool) error {
	a, err := r.get(id)
	if err != nil {
		return err
	}
	err = a.session.Approve(ctx, token, approval, allow)
	r.changed(id)
	return err
}
func (r *Registry) Edit(id, message, text string) error {
	a, err := r.get(id)
	if err != nil {
		return err
	}
	err = a.session.Edit(message, text)
	r.changed(id)
	return err
}
func (r *Registry) Release(id string) error {
	r.mu.Lock()
	if done := r.releasing[id]; done != nil {
		r.mu.Unlock()
		<-done
		return nil
	}
	a := r.actors[id]
	if a == nil {
		r.mu.Unlock()
		return nil
	}
	done := make(chan struct{})
	r.releasing[id] = done
	delete(r.actors, id)
	hooks := []func(string){}
	for _, release := range r.releases {
		if release != nil {
			hooks = append(hooks, release)
		}
	}
	r.mu.Unlock()
	if a != nil {
		a.cancel()
		a.session.Interrupt("application owner released; no automatic replay")
		_ = a.lease.Close()
	}
	for _, release := range hooks {
		release(id)
	}
	r.mu.Lock()
	delete(r.releasing, id)
	close(done)
	r.mu.Unlock()
	return nil
}
func (r *Registry) Delete(id string) error {
	a, err := r.get(id)
	if err != nil {
		return err
	}
	if err = a.session.Retire(a.lease.Retire); err != nil {
		return err
	}
	_ = r.Release(id)
	r.changed(id)
	return nil
}
func (r *Registry) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	ids := []string{}
	for id := range r.actors {
		ids = append(ids, id)
	}
	for id := range r.releasing {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		_ = r.Release(id)
	}
}

func (r *Registry) CancelTurn(ctx context.Context, id, turn string, before uint64) (cr.CancelResult, error) {
	a, err := r.get(id)
	if err != nil {
		return cr.CancelResult{}, err
	}
	result, err := a.session.CancelTurn(ctx, turn, before)
	r.changed(id)
	return result, err
}
