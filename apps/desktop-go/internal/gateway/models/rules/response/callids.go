// Package response mirrors packages/gateway/src/models/rules/response.
// callids.go mirrors callIds.ts (deterministic call ids, wire-safe escaping).
package response

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var messagesID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var b64urlRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

const chatIDMax = 40
const escapePrefix = "nomi_"

// CallIds mirrors class CallIds.
type CallIds struct {
	Seed string
	n    int
}

// NewCallIds mirrors `new CallIds(seed?)`: empty seed → 8 random bytes hex.
func NewCallIds(seed *string) *CallIds {
	if seed != nil {
		return &CallIds{Seed: *seed}
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return &CallIds{Seed: hex.EncodeToString(b)}
}

// Next mirrors next().
func (c *CallIds) Next() string {
	s := "call_" + c.Seed + "_" + strconv.Itoa(c.n)
	c.n++
	return s
}

func historyOf(body any) any {
	b, ok := body.(*util.Obj)
	if !ok || b == nil {
		return body
	}
	h := b.Get("messages")
	if h == nil {
		h = b.Get("input")
	}
	if h == nil {
		h = b.Get("contents")
	}
	return []any{b.Get("system"), b.Get("instructions"), h}
}

// CallIDSeed mirrors callIdSeed. JSON.stringify writes undefined array slots as
// null, which is what Get returns for a missing key.
func CallIDSeed(body any) string {
	text := ""
	switch body.(type) {
	case nil:
		text = "" // JSON.stringify(undefined) ?? '' ; null → "null" handled below
	}
	if body != nil {
		text = util.Stringify(historyOf(body))
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])[:12]
}

// EscapeCallID mirrors escapeCallId.
func EscapeCallID(id string) string {
	if id == "" || messagesID.MatchString(id) {
		return id
	}
	return escapePrefix + base64.RawURLEncoding.EncodeToString([]byte(id))
}

// UnescapeCallID mirrors unescapeCallId.
func UnescapeCallID(id string) string {
	if !strings.HasPrefix(id, escapePrefix) {
		return id
	}
	raw := id[len(escapePrefix):]
	if raw == "" || !b64urlRe.MatchString(raw) {
		return id
	}
	dec, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
	if err != nil {
		return id
	}
	orig := util.Stringify(string(dec)) // normalise invalid UTF-8 like Buffer#toString
	o, _ := util.ParseString(orig)
	s, _ := o.(string)
	if EscapeCallID(s) == id {
		return s
	}
	return id
}

// CallIDForWire mirrors callIdForWire.
func CallIDForWire(wire, id string) string {
	if id == "" {
		return id
	}
	if wire == "messages" {
		return EscapeCallID(id)
	}
	if wire == "chat" && utf16Len(id) > chatIDMax {
		sum := sha256.Sum256([]byte(id))
		return "call_" + hex.EncodeToString(sum[:])[:32]
	}
	return id
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
