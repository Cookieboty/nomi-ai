// Package mainchat owns the application ingress for opted-in product chats.
// Factories are metadata-only; user turns run solely through leased Sessions.
package mainchat

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
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
type RuntimeConfig struct {
	Source         string `json:"source,omitempty"`
	Model          string `json:"model,omitempty"`
	AccountID      string `json:"accountId,omitempty"`
	PermissionMode string `json:"permissionMode,omitempty"`
	Effort         string `json:"effort,omitempty"`
}

type NativeTitleLookup func(ctx context.Context, backend, nativeSessionID, configDir string) string

type managedAutoTitle struct {
	Name   string
	Source string // "heuristic" | "smart" | "native"
}

type titleLookupEntry struct {
	seq    uint64
	cancel context.CancelFunc
}

type Registry struct {
	mu                     sync.Mutex
	store                  *convstore.Store
	factories              map[string]Factory
	actors                 map[string]*actor
	configs                map[string]map[string]RuntimeConfig
	autoTitles             map[string]managedAutoTitle
	titleGens              map[string]uint64
	titleLookups           map[string]titleLookupEntry
	lookupSeq              uint64
	nativeTitleLookup      NativeTitleLookup
	nativeTitleRetryDelays []time.Duration
	closed                 bool
	notify                 func(string)
	streamNotify           func(string)
	releases               map[string]func(string)
	releasing              map[string]chan struct{}
	probe                  func(string) []RuntimeChoice
}

func New(s *convstore.Store, notify func(string)) *Registry {
	return &Registry{
		store:        s,
		factories:    map[string]Factory{},
		actors:       map[string]*actor{},
		configs:      map[string]map[string]RuntimeConfig{},
		autoTitles:   map[string]managedAutoTitle{},
		titleGens:    map[string]uint64{},
		titleLookups: map[string]titleLookupEntry{},
		notify:       notify,
		releases:     map[string]func(string){},
		releasing:    map[string]chan struct{}{},
	}
}

type sessionTitleSource interface {
	SetTitleHandler(func(string))
}

type sessionNativeMetaSource interface {
	NativeSessionMeta() (sessionID, configDir string)
}

var defaultNativeTitleRetryDelays = []time.Duration{
	0,
	1500 * time.Millisecond,
	3500 * time.Millisecond,
}

func (r *Registry) SetNativeTitleLookup(fn NativeTitleLookup) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nativeTitleLookup = fn
}

func (r *Registry) SetNativeTitleRetryDelays(delays []time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(delays) == 0 {
		r.nativeTitleRetryDelays = nil
		return
	}
	r.nativeTitleRetryDelays = append([]time.Duration(nil), delays...)
}

func (r *Registry) cancelTitleLookup(id string) {
	r.mu.Lock()
	if entry, ok := r.titleLookups[id]; ok {
		delete(r.titleLookups, id)
		r.mu.Unlock()
		if entry.cancel != nil {
			entry.cancel()
		}
		return
	}
	r.mu.Unlock()
}

var reAttachedFileBlock = regexp.MustCompile(`(?s)<attached-file\b[^>]*?(?:/>|>.*?</attached-file>)`)

func isDefaultManagedTitle(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || trimmed == "ui.chat-settings.new-chat" || trimmed == "新对话" || trimmed == "新会话" || strings.EqualFold(trimmed, "new chat") {
		return true
	}
	if def := strings.TrimSpace(i18n.T("ui.chat-settings.new-chat")); def != "" && trimmed == def {
		return true
	}
	return false
}

func cleanManagedTitle(raw string, maxRunes int) string {
	s := reAttachedFileBlock.ReplaceAllString(raw, " ")
	s = clisdk.StripCarriedContext(s)
	s = strings.Join(strings.Fields(s), " ")
	if s == "" || maxRunes <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	return string([]rune(s)[:maxRunes])
}

// SetStreamNotify registers a lightweight callback for high-frequency streaming/trace updates.
func (r *Registry) SetStreamNotify(fn func(string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.streamNotify = fn
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

type RuntimeAccountOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type RuntimeModelOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type RuntimeChoice struct {
	ID, Status, Detail, Login  string
	Available, RequiresProject bool
	HasLocalLogin              *bool
	Degraded                   []string
	Accounts                   []RuntimeAccountOption
	Models                     []RuntimeModelOption
	PermissionModes            []string
	Bridges                    *cr.CapabilityBridges
}

func (r *Registry) ConfigFor(id, backend string) RuntimeConfig {
	r.mu.Lock()
	defer r.mu.Unlock()
	if perConv := r.configs[id]; perConv != nil {
		return perConv[backend]
	}
	return RuntimeConfig{}
}

func (r *Registry) SetConfig(id, backend string, cfg RuntimeConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.configs == nil {
		r.configs = map[string]map[string]RuntimeConfig{}
	}
	if r.configs[id] == nil {
		r.configs[id] = map[string]RuntimeConfig{}
	}
	r.configs[id][backend] = cfg
}

func (r *Registry) SetProbe(probe func(string) []RuntimeChoice) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.probe = probe
}
func (r *Registry) Choices(id string) []RuntimeChoice {
	r.mu.Lock()
	probe := r.probe
	r.mu.Unlock()
	if probe == nil {
		return nil
	}
	return probe(id)
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
	if src, ok := t.Runtime.(sessionTitleSource); ok {
		src.SetTitleHandler(func(title string) { r.ApplyNativeTitle(id, title) })
	}
	rawRuntime := t.Runtime
	t.Runtime = &observedRuntime{
		Runtime:      rawRuntime,
		notify:       func() { r.changed(id) },
		streamNotify: func() { r.streamChanged(id) },
		onCompleted:  func(e cr.Event) { r.syncTurnCompletedMeta(id, rawRuntime, e) },
	}
	return t, nil
}
func (r *Registry) changed(id string) {
	if r.notify != nil {
		r.notify(id)
	}
}
func (r *Registry) streamChanged(id string) {
	r.mu.Lock()
	fn := r.streamNotify
	r.mu.Unlock()
	if fn != nil {
		fn(id)
		return
	}
	r.changed(id)
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
	cp := c.Checkpoint()
	if drv := cp.Selected.Identity.DriverID; drv != "" && drv != "api" {
		if r.configs == nil {
			r.configs = map[string]map[string]RuntimeConfig{}
		}
		if r.configs[id] == nil {
			r.configs[id] = map[string]RuntimeConfig{}
		}
		if _, exists := r.configs[id][drv]; !exists {
			src := cp.Selected.Identity.Source
			switch src {
			case "local", "official", "thirdParty":
			case "official-default-login-unverified":
				src = "local"
			default:
				src = ""
			}
			accID := cp.Selected.Identity.AccountID
			if src != "official" || accID == "local" || accID == "thirdParty" || accID == "default" || strings.HasPrefix(accID, "config-source:") {
				accID = ""
			}
			model := cp.Selected.Env.Model
			if model == "cli-default" {
				model = ""
			}
			r.configs[id][drv] = RuntimeConfig{
				Source:         src,
				Model:          model,
				AccountID:      accID,
				PermissionMode: cp.Selected.Env.PermissionMode,
				Effort:         cp.Selected.Effort,
			}
		}
	}
	return a, nil
}

// Adopt must be explicitly confirmed and must resolve a supported target BEFORE
// publishing ownership. In particular Windows and missing CLIs cannot adopt.
func (r *Registry) Adopt(id, name string, confirm bool) error {
	return r.AdoptWithOptions(id, name, confirm, SwitchOptions{})
}

func (r *Registry) AdoptWithOptions(id, name string, confirm bool, opts SwitchOptions) error {
	if !confirm {
		return cr.ErrPermission
	}
	if !convstore.ManagedSupported() {
		return convstore.ErrDurabilityUnsupported
	}
	prevCfg := r.ConfigFor(id, name)
	baseCfg := prevCfg
	resetPerm := opts.PermissionMode == "" && prevCfg.PermissionMode != ""
	if resetPerm {
		baseCfg.PermissionMode = ""
	}
	hasCustom := resetPerm || opts.Source != "" || opts.Model != "" || opts.Effort != "" || opts.PermissionMode != "" || opts.AccountID != ""
	if hasCustom {
		r.SetConfig(id, name, mergeRuntimeConfig(baseCfg, opts))
	}
	rollback := func() {
		if hasCustom {
			r.SetConfig(id, name, prevCfg)
		}
	}
	t, err := r.target(id, name)
	if err != nil {
		rollback()
		return err
	}
	if hasCustom {
		applyConfigToTarget(&t, r.ConfigFor(id, name))
	}
	// Validate metadata/permissions without executing or migrating anything.
	probe, _ := cr.NewSession(id, nil)
	if err = probe.Select(t); err != nil {
		rollback()
		return err
	}
	if _, err = r.store.AdoptManaged(id); err != nil {
		rollback()
		return err
	}
	a, err := r.get(id)
	if err != nil {
		rollback()
		return err
	}
	t, err = r.target(id, name)
	if err != nil {
		rollback()
		return err
	}
	if hasCustom {
		applyConfigToTarget(&t, r.ConfigFor(id, name))
	}
	if err = a.session.Select(t); err != nil {
		rollback()
		return err
	}
	r.changed(id)
	return nil
}

type SwitchOptions struct {
	Backend            string
	Source             string
	Model              string
	Effort             string
	PermissionMode     string
	AccountID          string
	Confirm            bool
	ConfirmUnsafe      bool
	ExpectedGeneration *uint64
}

func (r *Registry) Resolve(id, decision string, confirm bool, expected *uint64) error {
	if !confirm {
		return cr.ErrPermission
	}
	a, err := r.get(id)
	if err != nil {
		return err
	}
	switch decision {
	case "new-native":
		if a.session.NeedsRuntime() {
			name := a.session.Checkpoint().Selected.Identity.DriverID
			t, e := r.target(id, name)
			if e != nil {
				return e
			}
			if e = a.session.Reattach(t); e != nil {
				return e
			}
		}
		err = a.session.ResolveUnprovenResume(expected)
	case "rollback-switch":
		err = a.session.ResolveInterruptedSwitch(expected, decision)
	case "abandon":
		err = a.session.ResolveAbandon(expected)
	default:
		return cr.ErrPermission
	}
	r.changed(id)
	return err
}

func mergeRuntimeConfig(prev RuntimeConfig, opts SwitchOptions) RuntimeConfig {
	next := prev
	if opts.Source != "" && opts.Source != prev.Source {
		next.Source = opts.Source
		next.Model = ""
		next.AccountID = ""
		next.Effort = ""
	}
	if opts.Model == "cli-default" {
		next.Model = ""
	} else if opts.Model != "" {
		next.Model = opts.Model
	}
	if opts.PermissionMode != "" {
		next.PermissionMode = opts.PermissionMode
	}
	if opts.AccountID == "default" {
		next.AccountID = ""
	} else if opts.AccountID != "" {
		next.AccountID = opts.AccountID
	}
	if opts.Effort == "default" {
		next.Effort = ""
	} else if opts.Effort != "" {
		next.Effort = opts.Effort
	}
	return next
}

func applyConfigToTarget(t *cr.Target, cfg RuntimeConfig) {
	if t.Env.Model == "" && cfg.Model != "" {
		t.Env.Model = cfg.Model
	}
	if t.Env.PermissionMode == "" && cfg.PermissionMode != "" {
		t.Env.PermissionMode = cfg.PermissionMode
	}
	if t.Identity.AccountID == "" && cfg.AccountID != "" {
		t.Identity.AccountID = cfg.AccountID
	}
	if t.Effort == "" && cfg.Effort != "" {
		t.Effort = cfg.Effort
	}
}

func (r *Registry) Switch(ctx context.Context, id string, opts SwitchOptions) (cr.SwitchOutcome, error) {
	if !opts.Confirm {
		return cr.SwitchOutcome{}, cr.ErrPermission
	}
	a, err := r.get(id)
	if err != nil {
		return cr.SwitchOutcome{}, err
	}
	prevCfg := r.ConfigFor(id, opts.Backend)
	baseCfg := prevCfg
	// Cross-backend switch resets any stale PermissionMode on the target backend
	// unless the caller explicitly specifies a mode (same-backend updates keep it).
	if currentBackend := a.session.Checkpoint().Selected.Identity.DriverID; opts.Backend != currentBackend && opts.PermissionMode == "" {
		baseCfg.PermissionMode = ""
	}
	nextCfg := mergeRuntimeConfig(baseCfg, opts)
	r.SetConfig(id, opts.Backend, nextCfg)
	t, err := r.target(id, opts.Backend)
	if err != nil {
		r.SetConfig(id, opts.Backend, prevCfg)
		return cr.SwitchOutcome{}, err
	}
	applyConfigToTarget(&t, nextCfg)
	if opts.ConfirmUnsafe {
		t.ConfirmUnsafe = true
	}
	outcome, err := a.session.Switch(ctx, t, opts.ExpectedGeneration)
	if err != nil {
		r.SetConfig(id, opts.Backend, prevCfg)
	} else {
		r.cancelTitleLookup(id)
	}
	r.changed(id)
	return outcome, err
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
	if err == nil {
		r.cancelTitleLookup(id)
	}
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
	if err == nil {
		r.syncTurnStartedMeta(id, a, request.Text)
	}
	r.changed(id)
	return token, err
}

func (r *Registry) syncTurnStartedMeta(id string, a *actor, text string) {
	if a == nil || a.lease == nil {
		return
	}
	heuristic := cleanManagedTitle(text, 30)
	var appliedAuto string
	_ = a.lease.UpdateMeta(func(meta map[string]any) bool {
		meta["updatedAt"] = time.Now().UnixMilli()
		curName, _ := meta["name"].(string)
		if heuristic != "" && isDefaultManagedTitle(curName) {
			meta["name"] = heuristic
			appliedAuto = heuristic
		}
		return true
	})
	if appliedAuto != "" {
		r.mu.Lock()
		if r.autoTitles == nil {
			r.autoTitles = map[string]managedAutoTitle{}
		}
		r.autoTitles[id] = managedAutoTitle{Name: appliedAuto, Source: "heuristic"}
		r.mu.Unlock()
	}
}

func (r *Registry) syncTurnCompletedMeta(id string, rawRuntime cr.Runtime, e cr.Event) {
	r.mu.Lock()
	a := r.actors[id]
	r.mu.Unlock()
	if a == nil || a.lease == nil {
		return
	}
	model := strings.TrimSpace(e.Model)
	if model == "" || model == "cli-default" || model == "chat-route" {
		model = ""
		msgs := a.session.Messages()
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].Role == "assistant" {
				m := strings.TrimSpace(msgs[i].Model)
				if m != "" && m != "cli-default" && m != "chat-route" {
					model = m
				}
				break
			}
		}
	}
	var curName string
	_ = a.lease.UpdateMeta(func(meta map[string]any) bool {
		meta["updatedAt"] = time.Now().UnixMilli()
		if model != "" {
			meta["modelId"] = model
		}
		curName, _ = meta["name"].(string)
		return true
	})
	r.scheduleNativeTitleLookup(id, a, rawRuntime, e, curName)
}

func (r *Registry) scheduleNativeTitleLookup(id string, a *actor, rawRuntime cr.Runtime, e cr.Event, curName string) {
	if a == nil || a.ctx == nil || a.ctx.Err() != nil {
		return
	}
	backend := strings.TrimSpace(a.session.Checkpoint().Selected.Identity.DriverID)
	if backend == "" || backend == "api" {
		return
	}

	r.mu.Lock()
	lookup := r.nativeTitleLookup
	rec := r.autoTitles[id]
	delays := r.nativeTitleRetryDelays
	closed := r.closed
	r.mu.Unlock()
	if closed || lookup == nil {
		return
	}
	initialDefault := isDefaultManagedTitle(curName)
	if !initialDefault && (rec.Name == "" || curName != rec.Name || rec.Source == "native") {
		return
	}

	nativeSID := strings.TrimSpace(e.NativeSessionID)
	configDir := ""
	type unwrapper interface {
		UnwrapRuntime() cr.Runtime
	}
	rt := rawRuntime
	for rt != nil {
		if src, ok := rt.(sessionNativeMetaSource); ok {
			sid, cfgDir := src.NativeSessionMeta()
			if s := strings.TrimSpace(sid); s != "" {
				nativeSID = s
			}
			configDir = strings.TrimSpace(cfgDir)
			break
		}
		if u, ok := rt.(unwrapper); ok {
			next := u.UnwrapRuntime()
			if next == rt {
				break
			}
			rt = next
			continue
		}
		break
	}
	if nativeSID == "" {
		return
	}
	if len(delays) == 0 {
		delays = defaultNativeTitleRetryDelays
	} else {
		delays = append([]time.Duration(nil), delays...)
	}
	hadRecordedTitle := rec.Name != ""

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	if r.titleLookups == nil {
		r.titleLookups = map[string]titleLookupEntry{}
	}
	if prev, ok := r.titleLookups[id]; ok {
		delete(r.titleLookups, id)
		if prev.cancel != nil {
			prev.cancel()
		}
	}
	r.lookupSeq++
	mySeq := r.lookupSeq
	ctx, cancel := context.WithCancel(a.ctx)
	r.titleLookups[id] = titleLookupEntry{seq: mySeq, cancel: cancel}
	r.mu.Unlock()

	go func(expectedActor *actor) {
		defer func() {
			cancel()
			r.mu.Lock()
			if cur, ok := r.titleLookups[id]; ok && cur.seq == mySeq {
				delete(r.titleLookups, id)
			}
			r.mu.Unlock()
		}()
		canAccept := func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			if r.closed || r.actors[id] != expectedActor {
				return false
			}
			cur := r.autoTitles[id]
			if cur.Source == "native" {
				return false
			}
			if cur.Name != "" {
				return true
			}
			return !hadRecordedTitle && initialDefault
		}
		for _, wait := range delays {
			if wait > 0 {
				timer := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			} else if ctx.Err() != nil {
				return
			}
			if !canAccept() {
				return
			}
			if title := strings.TrimSpace(lookup(ctx, backend, nativeSID, configDir)); title != "" {
				if !canAccept() {
					return
				}
				r.ApplyNativeTitle(id, title)
				return
			}
		}
	}(a)
}

// ApplyNativeTitle updates the managed conversation title when the active runtime pushes
// a session title and the conversation still has a default, heuristic, smart, or earlier native title.
func (r *Registry) ApplyNativeTitle(id, rawTitle string) {
	next := cleanManagedTitle(rawTitle, 60)
	if next == "" {
		return
	}
	r.mu.Lock()
	a := r.actors[id]
	rec := r.autoTitles[id]
	var gen uint64
	if r.titleGens != nil {
		gen = r.titleGens[id]
	}
	r.mu.Unlock()
	if a == nil || a.lease == nil {
		return
	}
	updated := false
	err := a.lease.UpdateMeta(func(meta map[string]any) bool {
		curName, _ := meta["name"].(string)
		if !isDefaultManagedTitle(curName) && (rec.Name == "" || curName != rec.Name) {
			return false
		}
		if curName == next {
			return false
		}
		meta["name"] = next
		updated = true
		return true
	})
	if err == nil {
		promoted := false
		r.mu.Lock()
		var curGen uint64
		if r.titleGens != nil {
			curGen = r.titleGens[id]
		}
		if r.actors[id] == a && curGen == gen {
			if r.autoTitles == nil {
				r.autoTitles = map[string]managedAutoTitle{}
			}
			if updated || (rec.Name != "" && rec.Name == next && rec.Source != "native") {
				r.autoTitles[id] = managedAutoTitle{Name: next, Source: "native"}
				promoted = true
			}
		}
		r.mu.Unlock()
		if updated || promoted {
			r.cancelTitleLookup(id)
		}
		if updated {
			r.changed(id)
		}
	}
}

type ManagedMetaPatch struct {
	Name          *string
	AutoTitle     bool
	PinnedAtSet   bool
	PinnedAt      *int64
	ArchivedAtSet bool
	ArchivedAt    *int64
}

// UpdateMeta applies controlled sidebar metadata changes (name, pinnedAt, archivedAt) on a managed conversation.
func (r *Registry) UpdateMeta(id string, patch ManagedMetaPatch) error {
	var nextName *string
	if patch.Name != nil {
		var trimmed string
		if patch.AutoTitle {
			trimmed = cleanManagedTitle(*patch.Name, 60)
		} else {
			trimmed = strings.TrimSpace(*patch.Name)
		}
		if trimmed == "" {
			return cr.ErrBadEdit
		}
		nextName = &trimmed
	}
	a, err := r.get(id)
	if err != nil {
		return err
	}
	r.mu.Lock()
	rec := r.autoTitles[id]
	var gen uint64
	if r.titleGens != nil {
		gen = r.titleGens[id]
	}
	if nextName != nil && !patch.AutoTitle {
		if r.titleGens == nil {
			r.titleGens = map[string]uint64{}
		}
		r.titleGens[id]++
		delete(r.autoTitles, id)
	}
	r.mu.Unlock()
	if nextName != nil && !patch.AutoTitle {
		r.cancelTitleLookup(id)
	}
	changed := false
	wroteAutoName := false
	err = a.lease.UpdateMeta(func(meta map[string]any) bool {
		dirty := false
		if nextName != nil {
			cur, _ := meta["name"].(string)
			if patch.AutoTitle {
				if cur != *nextName && (isDefaultManagedTitle(cur) || (rec.Name != "" && cur == rec.Name && rec.Source == "heuristic")) {
					meta["name"] = *nextName
					dirty = true
					wroteAutoName = true
				}
			} else if cur != *nextName {
				meta["name"] = *nextName
				dirty = true
			}
		}
		if patch.PinnedAtSet {
			if patch.PinnedAt != nil {
				cur, has := parseMetaInt64(meta["pinnedAt"])
				if !has || cur != *patch.PinnedAt {
					meta["pinnedAt"] = *patch.PinnedAt
					dirty = true
				}
			} else if _, exists := meta["pinnedAt"]; exists {
				delete(meta, "pinnedAt")
				dirty = true
			}
		}
		if patch.ArchivedAtSet {
			if patch.ArchivedAt != nil {
				cur, has := parseMetaInt64(meta["archivedAt"])
				if !has || cur != *patch.ArchivedAt {
					meta["archivedAt"] = *patch.ArchivedAt
					dirty = true
				}
			} else if _, exists := meta["archivedAt"]; exists {
				delete(meta, "archivedAt")
				dirty = true
			}
		}
		changed = dirty
		return dirty
	})
	if err != nil {
		return err
	}
	if nextName != nil && patch.AutoTitle && wroteAutoName {
		r.mu.Lock()
		var curGen uint64
		if r.titleGens != nil {
			curGen = r.titleGens[id]
		}
		if r.actors[id] == a && curGen == gen {
			if r.autoTitles == nil {
				r.autoTitles = map[string]managedAutoTitle{}
			}
			r.autoTitles[id] = managedAutoTitle{Name: *nextName, Source: "smart"}
		}
		r.mu.Unlock()
	}
	if changed {
		r.changed(id)
	}
	return nil
}

func parseMetaInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	case int64:
		return x, true
	case float64:
		return int64(x), true
	default:
		return 0, false
	}
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
func (r *Registry) Rewind(id, message string, expected *uint64) error {
	a, err := r.get(id)
	if err != nil {
		return err
	}
	if err = a.session.Rewind(message, expected); err != nil {
		return err
	}
	r.changed(id)
	return nil
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
	delete(r.autoTitles, id)
	delete(r.titleGens, id)
	lookupEntry, hasLookup := r.titleLookups[id]
	if hasLookup {
		delete(r.titleLookups, id)
	}
	hooks := []func(string){}
	for _, release := range r.releases {
		if release != nil {
			hooks = append(hooks, release)
		}
	}
	r.mu.Unlock()
	if hasLookup && lookupEntry.cancel != nil {
		lookupEntry.cancel()
	}
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
	r.mu.Lock()
	delete(r.autoTitles, id)
	delete(r.titleGens, id)
	r.mu.Unlock()
	r.cancelTitleLookup(id)
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
	var pendingCancels []context.CancelFunc
	for id, entry := range r.titleLookups {
		if entry.cancel != nil {
			pendingCancels = append(pendingCancels, entry.cancel)
		}
		delete(r.titleLookups, id)
	}
	r.mu.Unlock()
	for _, cancel := range pendingCancels {
		cancel()
	}
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
