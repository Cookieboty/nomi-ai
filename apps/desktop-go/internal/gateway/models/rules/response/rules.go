package response

// Notes (NOTE_*).
const (
	NoteTextTools  = "正文里写出的工具调用已转成工具调用"
	NoteRepetition = "检测到模型复读，已中断"
	NoteToolNames  = "工具名已按映射还原"
	NoteChatStream = "已修正 Chat 流里的不规范字段"
)

// FixOptions is ResponseFixOptions. Notes is appended in place (dedup).
type FixOptions struct {
	ToolNames  map[string]string // upstream → original
	TextTools  map[string]bool
	Repetition bool
	Notes      *[]string
	CallIds    *CallIds
	// ChatStream is ChatPatchOptions.chatStream (nil = default on).
	ChatStream *bool
}

// AddNote is addNote.
func AddNote(notes *[]string, note string) {
	if notes == nil {
		return
	}
	for _, n := range *notes {
		if n == note {
			return
		}
	}
	*notes = append(*notes, note)
}

// ToolResolver is toolResolver.
func ToolResolver(provided map[string]bool, reverse map[string]string) Resolve {
	return func(name string) string {
		orig := name
		if r, ok := reverse[name]; ok {
			orig = r
		}
		if provided[orig] {
			return orig
		}
		return ""
	}
}

// FixesEnabled is fixesEnabled.
func FixesEnabled(o *FixOptions) bool {
	return o != nil && (len(o.ToolNames) > 0 || len(o.TextTools) > 0 || o.Repetition)
}

// FoundCall is FoundCall.
type FoundCall struct{ ID, Name, Args string }

// RestoreToolName is restoreToolName ("" = not mapped).
func RestoreToolName(name string, o *FixOptions) string {
	orig := o.ToolNames[name]
	if orig == "" {
		return ""
	}
	AddNote(o.Notes, NoteToolNames)
	return orig
}

// Rules is ResponseRules.
type Rules struct {
	o         *FixOptions
	guard     *RepetitionGuard
	extractor *TextToolExtractor
	IDs       *CallIds
	Tripped   bool
}

// NewRules is new ResponseRules(o).
func NewRules(o *FixOptions) *Rules {
	r := &Rules{o: o, IDs: o.CallIds}
	if r.IDs == nil {
		r.IDs = NewCallIds(nil)
	}
	if o.Repetition {
		r.guard = NewRepetitionGuard()
	}
	if len(o.TextTools) > 0 {
		r.extractor = NewTextToolExtractor(ToolResolver(o.TextTools, o.ToolNames))
	}
	return r
}

// Reasoning returns true when repetition tripped.
func (r *Rules) Reasoning(text string) bool { return text != "" && r.check("think", text) }

// Text returns emittable text; ok=false when repetition tripped.
func (r *Rules) Text(text string) (string, bool) {
	if r.check("text", text) {
		return "", false
	}
	if r.extractor != nil {
		return r.extractor.Push(text), true
	}
	return text, true
}

// Holding is `holding`.
func (r *Rules) Holding() bool { return r.extractor != nil && r.extractor.Active() }

// ReleaseRaw is releaseRaw.
func (r *Rules) ReleaseRaw() string {
	if r.Holding() {
		return r.extractor.Raw()
	}
	return ""
}

// Flush is flush.
func (r *Rules) Flush() (string, []FoundCall) {
	if !r.Holding() {
		return "", nil
	}
	text, cs := r.extractor.Flush()
	calls := make([]FoundCall, 0, len(cs))
	for _, c := range cs {
		calls = append(calls, FoundCall{ID: r.IDs.Next(), Name: c.Name, Args: c.Args})
	}
	if len(calls) > 0 {
		AddNote(r.o.Notes, NoteTextTools)
	}
	return text, calls
}

// ToolName is toolName.
func (r *Rules) ToolName(name string) string { return RestoreToolName(name, r.o) }

func (r *Rules) check(kind, text string) bool {
	if r.guard == nil || !r.guard.Push(kind, text) {
		return false
	}
	r.Tripped = true
	AddNote(r.o.Notes, NoteRepetition)
	return true
}

// ExtractTextCalls is extractTextCalls (ok=false → null).
func ExtractTextCalls(content string, o *FixOptions) (string, []FoundCall, bool) {
	if len(o.TextTools) == 0 || content == "" {
		return "", nil, false
	}
	c := *o
	c.Repetition = false
	rules := NewRules(&c)
	head, _ := rules.Text(content)
	text, calls := rules.Flush()
	if len(calls) == 0 {
		return "", nil, false
	}
	return head + text, calls, true
}
