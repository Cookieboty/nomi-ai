package server

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/clients"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	AffinityMax   = 1000
	AffinityTTLMs = 30 * 60_000
)

// AffinityTarget is AffinityTarget.
type AffinityTarget struct{ ProviderID, KeyID string }

func strv(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}

func hdr(h http.Header, name string) (string, bool) {
	v, ok := u.NodeHeader(h, name)
	return v, ok && v != ""
}

// pathOf is the dotted lookup (cur[k] on objects and arrays).
func pathOf(o any, path string) any {
	cur := o
	for _, k := range strings.Split(path, ".") {
		switch x := cur.(type) {
		case *u.Obj:
			if x == nil {
				return nil
			}
			v, _ := u.PlainGet(x, k)
			cur = v
		case []any:
			if k == "length" {
				cur = float64(len(x))
			} else if i, err := strconv.Atoi(k); err == nil && i >= 0 && strconv.Itoa(i) == k && i < len(x) {
				cur = x[i]
			} else {
				cur = nil
			}
		default:
			return nil
		}
	}
	return cur
}

var claudeSessRe = regexp.MustCompile(`(?i)session_([0-9a-f-]{8,})`)

func claudeUserSession(userID string) string {
	if j, err := u.Parse([]byte(userID)); err == nil {
		if o, ok := j.(*u.Obj); ok && o != nil {
			if sid, ok := strv(o.Get("session_id")); ok {
				return sid
			}
		}
	}
	if m := claudeSessRe.FindStringSubmatch(u.JSIText(userID)); m != nil {
		// group is ASCII-only, so offsets in the rewritten text are the same text.
		return m[1]
	}
	return userID
}

func arrOf(v any) []any { a, _ := v.([]any); return a }

func field(m any, k string) any {
	if o, ok := m.(*u.Obj); ok && o != nil {
		return o.Get(k)
	}
	return nil
}

func systemOf(wire string, b *u.Obj) any {
	switch wire {
	case "messages":
		return b.Get("system")
	case "responses":
		return b.Get("instructions")
	case "gemini":
		if v := b.Get("systemInstruction"); v != nil {
			return v
		}
		return b.Get("system_instruction")
	}
	for _, m := range arrOf(b.Get("messages")) {
		if r := field(m, "role"); r == "system" || r == "developer" {
			return field(m, "content")
		}
	}
	return nil
}

func firstUserOf(wire string, b *u.Obj) any {
	if wire == "responses" {
		if s, ok := b.Get("input").(string); ok {
			return s
		}
		for _, m := range arrOf(b.Get("input")) {
			if field(m, "role") == "user" {
				return field(m, "content")
			}
		}
		return nil
	}
	if wire == "gemini" {
		for _, m := range arrOf(b.Get("contents")) {
			if r := field(m, "role"); !u.Truthy(r) || r == "user" {
				return field(m, "parts")
			}
		}
		return nil
	}
	for _, m := range arrOf(b.Get("messages")) {
		if field(m, "role") == "user" {
			return field(m, "content")
		}
	}
	return nil
}

// SessionKey is sessionKey; "" means null. hashFallback defaults to true.
func SessionKey(wire string, h http.Header, body any, client string, hashFallback bool) string {
	b, _ := body.(*u.Obj)
	if b == nil {
		b = u.NewObj()
	}
	pre := ""
	if client != "" {
		pre = client + ":"
	}
	for _, r := range clients.SessionKeyRules(client) {
		var v string
		var ok bool
		if r.Header != "" {
			v, ok = hdr(h, r.Header)
		} else if r.BodyPath != "" {
			v, ok = strv(pathOf(b, r.BodyPath))
		}
		if ok {
			if r.Parse == "claude-user" {
				v = claudeUserSession(v)
			}
			return pre + r.Prefix + ":" + v
		}
	}
	if tab, ok := hdr(h, "x-nomi-tab"); ok {
		return pre + "tab:" + tab
	}
	if !hashFallback {
		return ""
	}
	user := firstUserOf(wire, b)
	if user == nil {
		return ""
	}
	sum := sha256.Sum256([]byte(u.Stringify([]any{systemOf(wire, b), user})))
	return client + "h:" + base64.RawURLEncoding.EncodeToString(sum[:])
}

type affEnt struct {
	AffinityTarget
	at float64
}

// Affinity is Affinity (session → last good provider/key, in-memory LRU).
type Affinity struct {
	now        func() float64
	max, ttlMs int
	m          *lru[affEnt]
}

// NowMs is Date.now.
func NowMs() float64 { return float64(time.Now().UnixMilli()) }

// NewAffinity is new Affinity(now, max, ttlMs); nil now / 0 use defaults.
func NewAffinity(now func() float64, max, ttlMs int) *Affinity {
	if now == nil {
		now = NowMs
	}
	if max == 0 {
		max = AffinityMax
	}
	if ttlMs == 0 {
		ttlMs = AffinityTTLMs
	}
	return &Affinity{now: now, max: max, ttlMs: ttlMs, m: newLRU[affEnt]()}
}

// Get is get.
func (a *Affinity) Get(session string) *AffinityTarget {
	e, ok := a.m.get(session)
	if !ok {
		return nil
	}
	a.m.del(session)
	if a.now()-e.at > float64(a.ttlMs) {
		return nil
	}
	a.m.set(session, e)
	t := e.AffinityTarget
	return &t
}

// Set is set.
func (a *Affinity) Set(session string, t AffinityTarget) {
	a.m.del(session)
	a.m.set(session, affEnt{t, a.now()})
	for a.m.size() > a.max {
		k, _ := a.m.oldest()
		a.m.del(k)
	}
}

// Size is size.
func (a *Affinity) Size() int { return a.m.size() }
