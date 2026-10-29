// Package clisdk mirrors packages/cli-sdk (docs/design/cli-plugin-architecture.md §5):
// the coding-assistant plugin contract and the shared session drivers.
//
// Events and protocol payloads are JavaScript objects in Node; Go keeps them as
// order-preserving *util.Obj values (deviation D15) so JSON.stringify output —
// what the renderer and the tab files see — stays byte-identical.
package clisdk

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Ev is a HarnessEvent / SessionEvent / any JS object literal.
type Ev = *util.Obj

// O builds an ordered object from alternating key/value pairs.
func O(kv ...any) Ev { return util.NewObj(kv...) }

// WithOpt mirrors withOpt: sets each optional key whose value is not undefined
// (Go nil stands for undefined here; set JS null with Obj.Set directly).
func WithOpt(ev Ev, kv ...any) Ev {
	for i := 0; i+1 < len(kv); i += 2 {
		v := kv[i+1]
		if isUndef(v) {
			continue
		}
		ev.Set(kv[i].(string), Deref(v))
	}
	return ev
}

// Deref unwraps optional pointers into JSON values.
func Deref(v any) any {
	switch x := v.(type) {
	case *string:
		return *x
	case *float64:
		return *x
	case *bool:
		return *x
	}
	return v
}

func isUndef(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case *string:
		return x == nil
	case *float64:
		return x == nil
	case *bool:
		return x == nil
	case *util.Obj:
		return x == nil
	}
	return false
}

/* ------------------------------ events.ts ------------------------------ */

// AnswerAllows mirrors answerAllows: nil = cancelled.
func AnswerAllows(a Ev, options []Ev) *bool {
	t, f := true, false
	if a.Has("optionId") {
		kind := ""
		for _, o := range options {
			if o.Get("id") == a.Get("optionId") {
				kind = util.Str(o.Get("kind"))
				break
			}
		}
		if strings.HasPrefix(kind, "reject") {
			return &f
		}
		return &t
	}
	if a.Get("decision") == "cancel" {
		return nil
	}
	if a.Get("decision") == "allow" {
		return &t
	}
	return &f
}

/* ------------------------------ lines.ts ------------------------------- */

var crlfSplit = regexp.MustCompile(`\r?\n`)

// LineSplitter mirrors LineSplitter.
type LineSplitter struct{ parts []string }

// Push returns the newly completed lines (CRLF stripped).
func (l *LineSplitter) Push(chunk string) []string {
	if chunk == "" {
		return []string{}
	}
	if !strings.Contains(chunk, "\n") {
		l.parts = append(l.parts, chunk)
		return []string{}
	}
	text := chunk
	if len(l.parts) > 0 {
		text = strings.Join(l.parts, "") + chunk
	}
	lines := crlfSplit.Split(text, -1)
	rest := lines[len(lines)-1]
	lines = lines[:len(lines)-1]
	if rest != "" {
		l.parts = []string{rest}
	} else {
		l.parts = nil
	}
	return lines
}

// Take returns and clears the unterminated remainder.
func (l *LineSplitter) Take() string {
	rest := strings.Join(l.parts, "")
	l.parts = nil
	return rest
}

/* ------------------------------ carry.ts ------------------------------- */

// CarryEnd mirrors CARRY_END.
const CarryEnd = "</previous_conversation>\n\n---\n\n"

// StripCarriedContext mirrors stripCarriedContext.
func StripCarriedContext(text string) string {
	i := strings.Index(text, CarryEnd)
	if i >= 0 && strings.HasPrefix(JSTrimStart(text), "[Nomi]") {
		return text[i+len(CarryEnd):]
	}
	return text
}

/* ------------------------------- i18n.ts ------------------------------- */

// Translate mirrors the Translate type.
type Translate func(key string, args ...any) string

var fmtRe = regexp.MustCompile(`\{(\d+)\}`)

func fallbackT(key string, args ...any) string {
	return fmtRe.ReplaceAllStringFunc(key, func(m string) string {
		i, err := strconv.Atoi(m[1 : len(m)-1])
		if err == nil && i < len(args) {
			return util.JSString(args[i])
		}
		return m
	})
}

var currentT Translate = fallbackT

// SetTranslate mirrors setTranslate (nil restores the key fallback).
func SetTranslate(fn Translate) {
	if fn == nil {
		currentT = fallbackT
		return
	}
	currentT = fn
}

// T mirrors t.
func T(key string, args ...any) string { return currentT(key, args...) }

/* ------------------------------ driver.ts ------------------------------ */

// AppendText mirrors appendText.
func AppendText(text string, ev Ev) string {
	switch ev.Get("type") {
	case "text-delta":
		return text + util.Str(ev.Get("text"))
	case "text":
		if text != "" {
			return text + "\n\n" + util.Str(ev.Get("text"))
		}
		return util.Str(ev.Get("text"))
	}
	return text
}

// JSThrow = jsrt.JSThrow（解析器以 panic(JSThrow) 复现 Node 的抛出；事件源用 jsrt.Dispatch 处理）。
type JSThrow = jsrt.JSThrow
