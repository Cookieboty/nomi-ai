// Package toolnames mirrors packages/gateway/src/toolNames.ts.
package toolnames

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var legal = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// IsLegalChatToolName is isLegalChatToolName.
func IsLegalChatToolName(name string) bool { return legal.MatchString(name) }

// ChatToolName is chatToolName.
func ChatToolName(name string) string {
	if legal.MatchString(name) {
		return name
	}
	sum := sha256.Sum256([]byte(u.ToWellFormed(name)))
	hash := hex.EncodeToString(sum[:])[:7]
	// name.replace(/[^a-zA-Z0-9_-]/g, '_') works per UTF-16 unit: an astral
	// code point is two units → "__". The result is ASCII, so slice by bytes.
	var b strings.Builder
	for i := 0; i < len(name); {
		c := name[i]
		if c < 0x80 {
			if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
				b.WriteByte(c)
			} else {
				b.WriteByte('_')
			}
			i++
			continue
		}
		n := len(u.UTF16Slice0(name[i:], 1)) // bytes of one code point
		if n == 0 {
			n = 1
		}
		r := []rune(name[i : i+n])
		if len(r) == 1 && r[0] >= 0x10000 {
			b.WriteString("__")
		} else {
			b.WriteByte('_')
		}
		i += n
	}
	base := b.String()
	if len(base) > 56 {
		base = base[:56]
	}
	if base == "" {
		base = "tool"
	}
	return base + "_" + hash
}

// IngressToolNames is ingressToolNames.
func IngressToolNames(wire string, body any) []string {
	o, ok := body.(*u.Obj)
	if !ok || o == nil {
		return []string{}
	}
	tools, ok := o.Get("tools").([]any)
	if !ok {
		return []string{}
	}
	out := []string{}
	for _, t := range tools {
		to, ok := t.(*u.Obj)
		if !ok || to == nil {
			continue
		}
		switch wire {
		case "chat":
			if fn, ok := to.Get("function").(*u.Obj); ok && fn != nil {
				if n, ok := fn.Get("name").(string); ok {
					out = append(out, n)
				}
			}
		case "gemini":
			ds, _ := to.Get("functionDeclarations").([]any)
			for _, d := range ds {
				if do, ok := d.(*u.Obj); ok && do != nil {
					if n, ok := do.Get("name").(string); ok {
						out = append(out, n)
					}
				}
			}
		default:
			if n, ok := to.Get("name").(string); ok {
				out = append(out, n)
			}
		}
	}
	return out
}

// ChatToolNameReverse is chatToolNameReverse (nil when nothing maps).
func ChatToolNameReverse(names []string) map[string]string {
	m := map[string]string{}
	for _, n := range names {
		if mapped := ChatToolName(n); mapped != n {
			m[mapped] = n
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// MapChatToolNames is mapChatToolNames (o is modified in place).
func MapChatToolNames(o *u.Obj, notes *[]string) {
	mapped := map[string]bool{}
	fnMap := func(fn any) any {
		f, ok := fn.(*u.Obj)
		if !ok || f == nil {
			return fn
		}
		name, ok := f.Get("name").(string)
		if !ok {
			return fn
		}
		n := ChatToolName(name)
		if n == name {
			return fn
		}
		mapped[name] = true
		return f.Clone().Set("name", n)
	}
	if tools, ok := o.Get("tools").([]any); ok {
		changed := false
		next := make([]any, len(tools))
		for i, t := range tools {
			next[i] = t
			to, ok := t.(*u.Obj)
			if !ok || to == nil {
				continue
			}
			fn := fnMap(to.Get("function"))
			if same(fn, to.Get("function")) {
				continue
			}
			changed = true
			next[i] = to.Clone().Set("function", fn)
		}
		if changed {
			o.Set("tools", next)
		}
	}
	if tc, ok := o.Get("tool_choice").(*u.Obj); ok && tc != nil {
		if f, ok := tc.Get("function").(*u.Obj); ok && f != nil {
			if fn := fnMap(f); !same(fn, f) {
				o.Set("tool_choice", tc.Clone().Set("function", fn))
			}
		}
	}
	if msgs, ok := o.Get("messages").([]any); ok {
		changed := false
		next := make([]any, len(msgs))
		for i, m := range msgs {
			next[i] = m
			mo, ok := m.(*u.Obj)
			if !ok || mo == nil {
				continue
			}
			nx := mo
			if calls, ok := mo.Get("tool_calls").([]any); ok {
				callsChanged := false
				nc := make([]any, len(calls))
				for j, tc := range calls {
					nc[j] = tc
					tco, ok := tc.(*u.Obj)
					if !ok || tco == nil {
						continue
					}
					fn := fnMap(tco.Get("function"))
					if same(fn, tco.Get("function")) {
						continue
					}
					callsChanged = true
					nc[j] = tco.Clone().Set("function", fn)
				}
				if callsChanged {
					nx = nx.Clone().Set("tool_calls", nc)
				}
			}
			if mo.Get("role") == "tool" {
				if name, ok := mo.Get("name").(string); ok {
					if n := ChatToolName(name); n != name {
						mapped[name] = true
						if nx == mo {
							nx = nx.Clone()
						}
						nx.Set("name", n)
					}
				}
			}
			if nx != mo {
				changed = true
			}
			next[i] = nx
		}
		if changed {
			o.Set("messages", next)
		}
	}
	if len(mapped) > 0 && notes != nil {
		*notes = append(*notes, strconv.Itoa(len(mapped))+" 个工具名已映射为 Chat 接口允许的名字")
	}
}

// same is JS `===` for the values fnMap returns (identity for objects).
func same(a, b any) bool {
	ao, aok := a.(*u.Obj)
	bo, bok := b.(*u.Obj)
	if aok || bok {
		return aok && bok && ao == bo
	}
	if _, ok := a.([]any); ok {
		return false
	}
	return a == b
}
