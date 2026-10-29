package server

import (
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	SessionsMax   = 5000
	SessionsTTLMs = 30 * 24 * 60 * 60_000
	saveDelayMs   = 2_000
)

// SessionOwner is a SessionOwner entry, kept as the JS object (entries read
// back from sessions.json are whatever JSON was there).
type SessionOwner struct{ o *u.Obj }

func (s *SessionOwner) str(k string) string { v, _ := s.o.Get(k).(string); return v }

// ProviderID / KeyID / Wire / Model / NoKeep read the fields.
func (s *SessionOwner) ProviderID() string { return s.str("providerId") }
func (s *SessionOwner) KeyID() string      { return s.str("keyId") }
func (s *SessionOwner) Wire() string       { return s.str("wire") }
func (s *SessionOwner) Model() string      { return s.str("model") }
func (s *SessionOwner) NoKeep() bool       { return u.Truthy(s.o.Get("noKeep")) }

func atOf(o *u.Obj) float64 {
	if !o.Has("at") {
		return math.NaN()
	}
	return u.JSToNumber(o.Get("at"))
}

// OwnerTarget is the {providerId, keyId, wire, model?} argument.
type OwnerTarget struct {
	ProviderID, KeyID, Wire string
	Model                   *string
}

// SessionTable is SessionTable.
type SessionTable struct {
	mu    sync.Mutex
	m     *lru[*u.Obj]
	file  string
	now   func() float64
	timer *time.Timer
}

// NewSessionTable is new SessionTable(file|null, now).
func NewSessionTable(file string, now func() float64) *SessionTable {
	if now == nil {
		now = NowMs
	}
	t := &SessionTable{m: newLRU[*u.Obj](), file: file, now: now}
	t.load()
	return t
}

func (t *SessionTable) get(session string) *u.Obj {
	e, ok := t.m.get(session)
	if !ok {
		return nil
	}
	if t.now()-atOf(e) > SessionsTTLMs {
		t.m.del(session)
		return nil
	}
	return e
}

// Get is get.
func (t *SessionTable) Get(session string) *SessionOwner {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e := t.get(session); e != nil {
		return &SessionOwner{e}
	}
	return nil
}

// CanKeep is canKeep ("" session = null).
func (t *SessionTable) CanKeep(session string, providerID, keyID, wire string) bool {
	if session == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.get(session)
	return e != nil && !u.Truthy(e.Get("noKeep")) && e.Get("providerId") == providerID && e.Get("keyId") == keyID && e.Get("wire") == wire
}

// Record is record.
func (t *SessionTable) Record(session string, o OwnerTarget) {
	if session == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	prev, _ := t.m.get(session)
	t.m.del(session)
	e := u.NewObj("providerId", o.ProviderID, "keyId", o.KeyID, "wire", o.Wire)
	if o.Model != nil {
		e.Set("model", *o.Model)
	}
	if prev != nil && u.Truthy(prev.Get("noKeep")) {
		e.Set("noKeep", true)
	}
	e.Set("at", t.now())
	t.m.set(session, e)
	for t.m.size() > SessionsMax {
		k, _ := t.m.oldest()
		t.m.del(k)
	}
	t.scheduleSave()
}

// MarkNoKeep is markNoKeep.
func (t *SessionTable) MarkNoKeep(session string) {
	if session == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.m.get(session); ok {
		e.Set("noKeep", true)
	} else {
		t.m.set(session, u.NewObj("providerId", "", "keyId", "", "wire", "chat", "noKeep", true, "at", t.now()))
	}
	t.scheduleSave()
}

// Flush is flush.
func (t *SessionTable) Flush() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.flush()
}

func (t *SessionTable) flush() {
	if t.timer != nil {
		t.timer.Stop()
	}
	t.timer = nil
	if t.file == "" {
		return
	}
	var arr []any
	t.m.each(func(k string, v *u.Obj) bool { arr = append(arr, []any{k, v}); return true })
	if arr == nil {
		arr = []any{}
	}
	data := u.Stringify(u.NewObj("version", float64(1), "sessions", arr))
	if os.MkdirAll(filepath.Dir(t.file), 0o777) != nil {
		return
	}
	tmp := t.file + ".tmp"
	if writeFileMode(tmp, []byte(data), 0o600) != nil {
		return
	}
	_ = os.Rename(tmp, t.file)
}

// writeFileMode is fs.writeFileSync(p, data, {mode}): mode applies only on create.
func writeFileMode(p string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func (t *SessionTable) scheduleSave() {
	if t.file == "" || t.timer != nil {
		return
	}
	t.timer = time.AfterFunc(saveDelayMs*time.Millisecond, t.Flush)
}

func (t *SessionTable) load() {
	if t.file == "" {
		return
	}
	b, err := os.ReadFile(t.file)
	if err != nil {
		return
	}
	raw, err := u.Parse(b)
	if err != nil {
		return
	}
	ro, ok := raw.(*u.Obj)
	if !ok || ro == nil {
		// null.sessions throws; other primitives have no .sessions → [].
		return
	}
	now := t.now()
	switch s := ro.Get("sessions").(type) {
	case nil:
	case string: // iterates code points; `[k, v] = 'x'` → v undefined
	case []any:
		for _, it := range s {
			var k, v any
			switch p := it.(type) {
			case []any:
				if len(p) > 0 {
					k = p[0]
				}
				if len(p) > 1 {
					v = p[1]
				}
			case string:
				continue // v is a 1-char string: no numeric .at
			default:
				return // not iterable: throws, earlier entries stay
			}
			ks, isS := k.(string)
			vo, isO := v.(*u.Obj)
			if isS && isO && vo != nil && now-atOf(vo) <= SessionsTTLMs {
				t.m.set(ks, vo)
			}
		}
	}
}
