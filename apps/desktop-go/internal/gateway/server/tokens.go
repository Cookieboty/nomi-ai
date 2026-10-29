package server

import (
	"crypto/sha1"
	"encoding/hex"
	"math"
	"net/http"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// EstimateTokens is estimateTokens.
func EstimateTokens(text string) float64 {
	if text == "" {
		return 0
	}
	cjk := 0
	for _, c := range u.CodePoints(text) {
		if (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) {
			cjk++
		}
	}
	rest := u.UTF16Len(text) - cjk
	return math.Max(1, math.Ceil(float64(float64(cjk)/1.5)+float64(float64(rest)/4))) // explicit float64(): no FMA
}

const roundUp = 1.05

// EstimateRequestTokens is estimateRequestTokens.
func EstimateRequestTokens(body any) float64 {
	if body == nil {
		body = u.NewObj()
	}
	return math.Ceil(EstimateTokens(u.Stringify(body)) * roundUp)
}

func sha1hex(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func listKey(wire string) string {
	switch wire {
	case "gemini":
		return "contents"
	case "responses":
		return "input"
	}
	return "messages"
}

func headOf(wire string, b *u.Obj) []any {
	switch wire {
	case "messages":
		return []any{b.Get("system"), b.Get("tools")}
	case "responses":
		return []any{b.Get("instructions"), b.Get("tools")}
	case "gemini":
		return []any{b.Get("systemInstruction"), b.Get("tools")}
	}
	return []any{b.Get("tools")}
}

// SessionKeyOf is sessionKeyOf.
func SessionKeyOf(wire string, h http.Header, body any) string {
	return SessionKey(wire, h, body, "", true)
}

type prefix struct {
	hashes    []string
	estimates []float64
}

func prefixOf(wire string, body any) *prefix {
	b, ok := body.(*u.Obj)
	if !ok || b == nil {
		return nil
	}
	lk := listKey(wire)
	var items []any
	if arr, ok := b.Get(lk).([]any); ok {
		items = arr
	} else if b.Has(lk) {
		items = []any{b.Get(lk)}
	}
	if len(items) == 0 {
		return nil
	}
	parts := append([]any{headOf(wire, b)}, items...)
	p := &prefix{}
	h := wire
	for _, x := range parts {
		s := u.Stringify(x)
		h = sha1hex(h + "\n" + s)
		p.hashes = append(p.hashes, h)
		p.estimates = append(p.estimates, EstimateTokens(s))
	}
	return p
}

type calRecord struct {
	hashes      []string
	inputTokens float64
}

type slot struct {
	at      float64
	records []calRecord
}

const (
	maxSlots       = 500
	slotTTLMs      = 30 * 60_000
	recordsPerSlot = 8
)

var (
	slotsMu sync.Mutex
	slots   = newLRU[*slot]()
)

// CalibrationKey is CalibrationKey.
type CalibrationKey struct {
	SessionKey, ProviderID, Model, Wire string
}

func slotKey(k CalibrationKey) string {
	return u.Stringify([]any{k.SessionKey, k.ProviderID, k.Model, k.Wire})
}

func getSlot(key string, now float64) *slot {
	s, ok := slots.get(key)
	if !ok {
		return nil
	}
	if now-s.at > slotTTLMs {
		slots.del(key)
		return nil
	}
	return s
}

func num0(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// MeasuredInputTokens is measuredInputTokens.
func MeasuredInputTokens(upstreamWire string, usage *events.StreamUsage) float64 {
	if usage == nil {
		return 0
	}
	in, rd, wr := num0(usage.InputTokens), num0(usage.CacheReadTokens), num0(usage.CacheWriteTokens)
	if upstreamWire == "messages" {
		return in + rd + wr
	}
	return in + wr
}

// RecordUsage is recordUsage (now nil = Date.now()).
func RecordUsage(k CalibrationKey, body any, inputTokens float64, nowp *float64) {
	if !(inputTokens > 0) {
		return
	}
	p := prefixOf(k.Wire, body)
	if p == nil {
		return
	}
	now := NowMs()
	if nowp != nil {
		now = *nowp
	}
	slotsMu.Lock()
	defer slotsMu.Unlock()
	key := slotKey(k)
	s := getSlot(key, now)
	if s == nil {
		s = &slot{at: now}
	}
	full := p.hashes[len(p.hashes)-1]
	kept := []calRecord{}
	for _, r := range s.records {
		if r.hashes[len(r.hashes)-1] != full {
			kept = append(kept, r)
		}
	}
	kept = append(kept, calRecord{p.hashes, inputTokens})
	if len(kept) > recordsPerSlot {
		kept = kept[1:]
	}
	s.records = kept
	s.at = now
	slots.del(key)
	slots.set(key, s)
	for slots.size() > maxSlots {
		o, _ := slots.oldest()
		slots.del(o)
	}
}

// CalibratedCount is calibratedCount.
func CalibratedCount(k CalibrationKey, body any, nowp *float64) float64 {
	p := prefixOf(k.Wire, body)
	now := NowMs()
	if nowp != nil {
		now = *nowp
	}
	slotsMu.Lock()
	defer slotsMu.Unlock()
	key := slotKey(k)
	var s *slot
	if p != nil {
		s = getSlot(key, now)
	}
	var best *calRecord
	if p != nil && s != nil {
		for i := range s.records {
			r := &s.records[i]
			n := len(r.hashes)
			if n > len(p.hashes) || r.hashes[n-1] != p.hashes[n-1] {
				continue
			}
			if best == nil || n > len(best.hashes) {
				best = r
			}
		}
	}
	if p == nil || best == nil || s == nil {
		return EstimateRequestTokens(body)
	}
	s.at = now
	slots.del(key)
	slots.set(key, s)
	suffix := 0.0
	for _, e := range p.estimates[len(best.hashes):] {
		suffix += e
	}
	return math.Ceil((best.inputTokens + suffix) * roundUp)
}

// ResetCalibration is resetCalibration.
func ResetCalibration() {
	slotsMu.Lock()
	slots = newLRU[*slot]()
	slotsMu.Unlock()
}
