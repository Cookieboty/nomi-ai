package route

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"regexp"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
)

// Tab token constants (route/binding.ts).
const (
	TabTokenPrefix     = "nomi-tab-"
	BindingWaitMs      = 2_000
	BindingRetryAfterS = 2
)

var (
	tabTokenRe = regexp.MustCompile(`^nomi-tab-[A-Za-z0-9_-]{32,}$`)
	hashRe     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// TabBinding is TabBinding. Models nil = missing (invalid).
type TabBinding struct {
	TokenHash  string               `json:"tokenHash"`
	Client     string               `json:"client"`
	TabID      string               `json:"tabId"`
	Generation float64              `json:"generation"`
	Models     *config.ClientModels `json:"models"`
	Effort     *string              `json:"effort,omitempty"`
}

// IsTabToken is isTabToken.
func IsTabToken(token string) bool { return tabTokenRe.MatchString(token) }

// HashTabToken is hashTabToken.
func HashTabToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// BindingMessage is BindingMessage.
type BindingMessage struct {
	Type      string      `json:"type"`
	ID        string      `json:"id"`
	Binding   *TabBinding `json:"binding,omitempty"`
	TokenHash string      `json:"tokenHash,omitempty"`
}

// BindingAck is BindingAck.
type BindingAck struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Message string `json:"message,omitempty"`
}

func validBinding(b *TabBinding) bool {
	return b != nil && hashRe.MatchString(b.TokenHash) && b.Client != "" &&
		b.Generation == math.Trunc(b.Generation) && !math.IsInf(b.Generation, 0) && b.Models != nil
}

// BindingTable is BindingTable (safe for concurrent use).
type BindingTable struct {
	mu      sync.Mutex
	order   []string // insertion order of byHash (Map iteration order)
	byHash  map[string]*TabBinding
	waiters map[string][]chan *TabBinding
}

// NewBindingTable returns an empty table.
func NewBindingTable() *BindingTable {
	return &BindingTable{byHash: map[string]*TabBinding{}, waiters: map[string][]chan *TabBinding{}}
}

// Size is size.
func (t *BindingTable) Size() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.byHash)
}

func (t *BindingTable) del(h string) {
	if _, ok := t.byHash[h]; !ok {
		return
	}
	delete(t.byHash, h)
	for i, x := range t.order {
		if x == h {
			t.order = append(t.order[:i:i], t.order[i+1:]...)
			break
		}
	}
}

// Add is add.
func (t *BindingTable) Add(b *TabBinding) error {
	if !validBinding(b) {
		return errors.New("invalid tab binding")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.add(b)
	return nil
}

func (t *BindingTable) add(b *TabBinding) {
	for _, h := range append([]string(nil), t.order...) {
		x := t.byHash[h]
		if x.TabID == b.TabID && x.Client == b.Client && x.Generation < b.Generation {
			t.del(h)
		}
	}
	if _, ok := t.byHash[b.TokenHash]; !ok {
		t.order = append(t.order, b.TokenHash)
	}
	t.byHash[b.TokenHash] = b
	if ws := t.waiters[b.TokenHash]; ws != nil {
		delete(t.waiters, b.TokenHash)
		for _, w := range ws {
			w <- b
		}
	}
}

// Update is update.
func (t *BindingTable) Update(b *TabBinding) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if b == nil {
		return errors.New("unknown tab binding")
	}
	if _, ok := t.byHash[b.TokenHash]; !ok {
		return errors.New("unknown tab binding")
	}
	if !validBinding(b) {
		return errors.New("invalid tab binding")
	}
	t.add(b)
	return nil
}

// Remove is remove.
func (t *BindingTable) Remove(h string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.del(h)
}

// Get is get (nil = null).
func (t *BindingTable) Get(h string) *TabBinding {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byHash[h]
}

// Lookup is lookup.
func (t *BindingTable) Lookup(token string, waitMs int) *TabBinding {
	if !IsTabToken(token) {
		return nil
	}
	h := HashTabToken(token)
	t.mu.Lock()
	if hit := t.byHash[h]; hit != nil || waitMs <= 0 {
		t.mu.Unlock()
		return hit
	}
	ch := make(chan *TabBinding, 1)
	t.waiters[h] = append(t.waiters[h], ch)
	t.mu.Unlock()
	timer := time.NewTimer(time.Duration(waitMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case b := <-ch:
		return b
	case <-timer.C:
		t.mu.Lock()
		defer t.mu.Unlock()
		select {
		case b := <-ch: // arrived while we took the lock
			return b
		default:
		}
		ws := t.waiters[h]
		keep := ws[:0:0]
		for _, w := range ws {
			if w != ch {
				keep = append(keep, w)
			}
		}
		if len(keep) > 0 {
			t.waiters[h] = keep
		} else {
			delete(t.waiters, h)
		}
		return nil
	}
}

// Handle is handle.
func (t *BindingTable) Handle(m BindingMessage) BindingAck {
	var err error
	switch m.Type {
	case "binding:add":
		err = t.Add(m.Binding)
	case "binding:update":
		err = t.Update(m.Binding)
	default:
		t.Remove(m.TokenHash)
	}
	if err != nil {
		return BindingAck{Type: "binding:error", ID: m.ID, Message: err.Error()}
	}
	return BindingAck{Type: "binding:ok", ID: m.ID}
}
