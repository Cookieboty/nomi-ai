// Package canonical mirrors packages/gateway/src/canonical: it rewrites
// non-standard upstream chunks into the canonical shape before decoding.
package canonical

import (
	"math"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func flatten(c []any) (text, think string) {
	for _, p := range c {
		o, ok := p.(*u.Obj)
		if !ok || o == nil {
			continue
		}
		if o.Get("type") == "text" && u.IsStr(o.Get("text")) {
			text += u.Str(o.Get("text"))
		} else if o.Get("type") == "thinking" {
			switch t := o.Get("thinking").(type) {
			case string:
				think += t
			case []any:
				ft, _ := flatten(t)
				think += ft
			}
		}
	}
	return
}

// ChatChunkNormalizer is ChatChunkNormalizer (mutates chunks in place).
type ChatChunkNormalizer struct {
	names    map[float64]string
	idIndex  map[string]float64
	maxIndex float64
}

// NewChatChunkNormalizer creates a normalizer.
func NewChatChunkNormalizer() *ChatChunkNormalizer {
	return &ChatChunkNormalizer{names: map[float64]string{}, idIndex: map[string]float64{}, maxIndex: -1}
}

func (n *ChatChunkNormalizer) indexFor(tc *u.Obj, pos int) float64 {
	if id := u.Str(tc.Get("id")); id != "" {
		if hit, ok := n.idIndex[id]; ok {
			return hit
		}
		idx := n.maxIndex + 1
		n.idIndex[id] = idx
		return idx
	}
	if n.maxIndex >= 0 {
		return n.maxIndex + float64(pos)
	}
	return float64(pos)
}

// Normalize reports whether the chunk was changed.
func (n *ChatChunkNormalizer) Normalize(j *u.Obj) bool {
	choices, _ := j.Get("choices").([]any)
	touched := false
	for _, cv := range choices {
		c, ok := cv.(*u.Obj)
		if !ok || c == nil {
			continue
		}
		if c.Get("finish_reason") == "" {
			c.Set("finish_reason", nil)
			touched = true
		}
		delta, ok := c.Get("delta").(*u.Obj)
		if !ok || delta == nil {
			continue
		}
		if arr, ok := delta.Get("content").([]any); ok {
			text, think := flatten(arr)
			if text != "" {
				delta.Set("content", text)
			} else {
				delta.Delete("content")
			}
			if think != "" && !u.IsStr(delta.Get("reasoning_content")) && !u.IsStr(delta.Get("reasoning")) {
				delta.Set("reasoning_content", think)
			}
			touched = true
		}
		for _, k := range []string{"reasoning_content", "reasoning"} {
			if delta.Has(k) && delta.Get(k) == "" {
				delta.Delete(k)
				touched = true
			}
		}
		calls, ok := delta.Get("tool_calls").([]any)
		if !ok {
			continue
		}
		if len(calls) == 0 {
			delta.Delete("tool_calls")
			touched = true
			continue
		}
		for pos, tcv := range calls {
			tc, ok := tcv.(*u.Obj)
			if !ok || tc == nil {
				continue
			}
			if !u.IsNum(tc.Get("index")) {
				tc.Set("index", n.indexFor(tc, pos))
				touched = true
			}
			idx, _ := tc.Get("index").(float64)
			n.maxIndex = math.Max(n.maxIndex, idx)
			if id := u.Str(tc.Get("id")); id != "" {
				if _, ok := n.idIndex[id]; !ok {
					n.idIndex[id] = idx
				}
			}
			fn, ok := tc.Get("function").(*u.Obj)
			if !ok || fn == nil {
				continue
			}
			switch fn.Get("arguments").(type) {
			case *u.Obj, []any:
				fn.Set("arguments", u.Stringify(fn.Get("arguments")))
				touched = true
			}
			if seen, ok := n.names[idx]; ok {
				if name, isStr := fn.Get("name").(string); isStr && (name == "" || name == seen) {
					fn.Delete("name")
					touched = true
				}
				continue
			}
			if name := u.Str(fn.Get("name")); name != "" {
				n.names[idx] = name
			}
		}
	}
	return touched
}
