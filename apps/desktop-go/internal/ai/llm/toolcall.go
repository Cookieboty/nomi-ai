package llm

import (
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const idAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// GenerateID is provider-utils generateId (16 chars of [0-9A-Za-z]).
// Tests replace it to match recorded ids.
var GenerateID = func() string {
	var b [16]byte
	for i := range b {
		b[i] = idAlphabet[rand.IntN(len(idAlphabet))]
	}
	return string(b[:])
}

// StartsWithStructuredValue is provider-utils startsWithStructuredValue.
func StartsWithStructuredValue(v *string) bool {
	if v == nil {
		return false
	}
	t := strings.TrimLeftFunc(*v, util.IsJSWS)
	return t != "" && (t[0] == '{' || t[0] == '[')
}

// argState is StreamingToolCallArgumentState.
type argState struct {
	kind     int // 0 undetermined, 1 other, 2 structured
	stack    []rune
	inString bool
	escaped  bool
	complete bool
}

func (s *argState) complete_() bool { return s.kind == 2 && s.complete }

func (s *argState) append(delta string) {
	for _, c := range delta {
		if s.kind == 0 {
			if util.IsJSWS(c) {
				continue
			}
			if c != '{' && c != '[' {
				s.kind = 1
				continue
			}
			s.kind, s.stack, s.inString, s.escaped, s.complete = 2, []rune{c}, false, false, false
			continue
		}
		if s.kind != 2 || s.complete {
			continue
		}
		if s.inString {
			if s.escaped {
				s.escaped = false
			} else if c == '\\' {
				s.escaped = true
			} else if c == '"' {
				s.inString = false
			}
			continue
		}
		switch c {
		case '"':
			s.inString = true
		case '{', '[':
			s.stack = append(s.stack, c)
		case '}', ']':
			want := '{'
			if c == ']' {
				want = '['
			}
			if len(s.stack) == 0 || s.stack[len(s.stack)-1] != want {
				s.kind = 1
				continue
			}
			s.stack = s.stack[:len(s.stack)-1]
			if len(s.stack) == 0 {
				s.complete = true
			}
		}
	}
}

// ToolCallDelta is StreamingToolCallDelta (nil pointer = null/undefined).
type ToolCallDelta struct {
	Index     *float64
	ID        *string
	Type      *string
	HasFunc   bool
	Name      *string
	Arguments *string
	Raw       any // provider-specific extras for ExtractMetadata
	Data      any // the wire delta as JSON (InvalidResponseDataError.data); nil = synthesized
}

type trackedCall struct {
	id       string
	index    *float64
	sequence int
	name     string
	args     string
	state    argState
	finished bool
	metadata ProviderMetadata
}

// ToolCallTracker is provider-utils StreamingToolCallTracker (typeValidation 'none').
type ToolCallTracker struct {
	Emit                  func(StreamPart)
	GenerateID            func() string
	ExtractMetadata       func(d ToolCallDelta) ProviderMetadata
	BuildProviderMetadata func(m ProviderMetadata) ProviderMetadata

	calls    []*trackedCall
	byID     map[string][]*trackedCall
	byIndex  map[float64][]*trackedCall
	used     map[string]bool
	suffixes map[string]int
}

func nonBlank(v *string) *string {
	if v != nil && util.JSTrim(*v) != "" {
		return v
	}
	return nil
}

func addUnique(list []*trackedCall, c *trackedCall) []*trackedCall {
	for _, x := range list {
		if x == c {
			return list
		}
	}
	return append(list, c)
}

type resolution struct {
	kind int // 0 new, 1 existing, 2 ambiguous
	call *trackedCall
}

// ProcessDelta handles one wire delta; a non-nil error is thrown from the transform.
func (t *ToolCallTracker) ProcessDelta(d ToolCallDelta) error {
	if t.byID == nil {
		t.byID, t.byIndex, t.used, t.suffixes = map[string][]*trackedCall{}, map[float64][]*trackedCall{}, map[string]bool{}, map[string]int{}
	}
	hasBlankName := d.Name != nil && util.JSTrim(*d.Name) == ""
	wireID := nonBlank(d.ID)
	name := nonBlank(d.Name)
	r := t.resolve(wireID, d.Index, name,
		name != nil && StartsWithStructuredValue(d.Arguments),
		d.Arguments == nil || util.JSTrim(*d.Arguments) == "")
	if r.kind == 2 {
		return nil
	}
	var c *trackedCall
	if r.kind == 0 {
		if hasBlankName {
			return nil
		}
		var err error
		if c, err = t.newCall(d, wireID, name); err != nil {
			return err
		}
	} else {
		c = r.call
		if wireID != nil {
			t.byID[*wireID] = addUnique(t.byID[*wireID], c)
		}
		if !c.finished && d.Arguments != nil {
			c.state.append(*d.Arguments)
			c.args += *d.Arguments
			t.Emit(StreamPart{Type: "tool-input-delta", ID: c.id, Delta: *d.Arguments})
		}
	}
	if d.Index != nil {
		t.byIndex[*d.Index] = addUnique(t.byIndex[*d.Index], c)
	}
	return nil
}

func (t *ToolCallTracker) resolve(wireID *string, index *float64, name *string, explicitStart, emptyArgs bool) resolution {
	var indexed []*trackedCall
	hasIndexed := false
	if index != nil {
		indexed, hasIndexed = t.byIndex[*index]
	}
	var matchingIndexed []*trackedCall
	for _, c := range indexed {
		if name == nil || c.name == *name {
			matchingIndexed = append(matchingIndexed, c)
		}
	}
	if wireID != nil {
		withID, ok := t.byID[*wireID]
		if ok {
			if index != nil {
				var m []*trackedCall
				for _, c := range matchingIndexed {
					for _, x := range withID {
						if x == c {
							m = append(m, c)
							break
						}
					}
				}
				r := matching(m, explicitStart)
				if r.kind != 0 {
					return r
				}
				if name != nil {
					return resolution{kind: 0}
				}
				if hasIndexed {
					return resolution{kind: 2}
				}
				return matching(withID, false)
			}
			if name != nil {
				var m []*trackedCall
				for _, c := range withID {
					if c.name == *name {
						m = append(m, c)
					}
				}
				return matching(m, explicitStart)
			}
			return matching(withID, false)
		}
		if len(matchingIndexed) > 0 {
			if explicitStart {
				return resolution{kind: 0}
			}
			return matching(matchingIndexed, name != nil && emptyArgs)
		}
		return resolution{kind: 0}
	}
	if hasIndexed {
		return matching(matchingIndexed, explicitStart)
	}
	if name != nil {
		return resolution{kind: 0}
	}
	var unfinished []*trackedCall
	for _, c := range t.calls {
		if !c.finished {
			unfinished = append(unfinished, c)
		}
	}
	return matching(unfinished, false)
}

func matching(calls []*trackedCall, explicitStart bool) resolution {
	if len(calls) == 0 {
		return resolution{kind: 0}
	}
	var cont []*trackedCall
	for _, c := range calls {
		if !c.state.complete_() {
			cont = append(cont, c)
		}
	}
	if !explicitStart && len(calls) == 1 {
		return resolution{kind: 1, call: calls[0]}
	}
	if len(cont) == 1 {
		return resolution{kind: 1, call: cont[0]}
	}
	if len(cont) > 1 || !explicitStart {
		return resolution{kind: 2}
	}
	return resolution{kind: 0}
}

func (t *ToolCallTracker) newCall(d ToolCallDelta, wireID, name *string) (*trackedCall, error) {
	if name == nil {
		return nil, NewInvalidResponseDataError(t.deltaJSON(d), "Expected 'function.name' to be a string.")
	}
	id := t.createID(wireID)
	t.Emit(StreamPart{Type: "tool-input-start", ID: id, ToolName: *name})
	var md ProviderMetadata
	if t.ExtractMetadata != nil {
		md = t.ExtractMetadata(d)
	}
	args := ""
	if d.Arguments != nil {
		args = *d.Arguments
	}
	c := &trackedCall{id: id, index: d.Index, sequence: len(t.calls), name: *name, args: args, metadata: md}
	c.state.append(args)
	t.calls = append(t.calls, c)
	if wireID != nil {
		t.byID[*wireID] = addUnique(t.byID[*wireID], c)
	}
	if args != "" {
		t.Emit(StreamPart{Type: "tool-input-delta", ID: id, Delta: args})
	}
	return c, nil
}

// deltaJSON is the delta as the SDK saw it (InvalidResponseDataError.data).
func (t *ToolCallTracker) deltaJSON(d ToolCallDelta) any {
	if d.Data != nil {
		return d.Data
	}
	o := util.NewObj()
	if d.Index != nil {
		o.Set("index", *d.Index)
	}
	if d.ID != nil {
		o.Set("id", *d.ID)
	} else {
		o.Set("id", nil)
	}
	f := util.NewObj()
	if d.Name != nil {
		f.Set("name", *d.Name)
	}
	if d.Arguments != nil {
		f.Set("arguments", *d.Arguments)
	}
	o.Set("function", f)
	return o
}

func (t *ToolCallTracker) createID(wireID *string) string {
	if wireID != nil && !t.used[*wireID] {
		t.used[*wireID] = true
		return *wireID
	}
	gen := t.GenerateID
	if gen == nil {
		gen = GenerateID
	}
	g := gen()
	if util.JSTrim(g) == "" {
		g = "tool-call"
	}
	if !t.used[g] {
		t.used[g] = true
		return g
	}
	start := t.suffixes[g]
	if start == 0 {
		start = 1
	}
	max := start + len(t.used)
	for s := start; s <= max; s++ {
		id := g + "-" + strconv.Itoa(s)
		if !t.used[id] {
			t.used[id] = true
			t.suffixes[g] = s + 1
			return id
		}
	}
	return g
}

// Flush finishes all open calls (sorted by index when every call has one).
func (t *ToolCallTracker) Flush() {
	calls := append([]*trackedCall(nil), t.calls...)
	all := true
	for _, c := range calls {
		if c.index == nil {
			all = false
		}
	}
	if all {
		sort.SliceStable(calls, func(i, j int) bool {
			if *calls[i].index != *calls[j].index {
				return *calls[i].index < *calls[j].index
			}
			return calls[i].sequence < calls[j].sequence
		})
	}
	for _, c := range calls {
		if c.finished {
			continue
		}
		t.Emit(StreamPart{Type: "tool-input-end", ID: c.id})
		var pm ProviderMetadata
		if t.BuildProviderMetadata != nil {
			pm = t.BuildProviderMetadata(c.metadata)
		}
		t.Emit(StreamPart{Type: "tool-call", ToolCallID: c.id, ToolName: c.name, Input: c.args, ProviderMetadata: pm})
		c.finished = true
	}
}
