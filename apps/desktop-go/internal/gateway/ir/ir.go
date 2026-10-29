// Package ir mirrors packages/gateway/src/ir.ts: the protocol-neutral request
// form every wire decodes into and encodes from. Optional TS fields are
// pointers (nil = undefined) so "absent" and "empty" stay distinct.
package ir

// Wire is the four downstream / upstream protocols.
type Wire = string

const (
	Messages  Wire = "messages"
	Responses Wire = "responses"
	Chat      Wire = "chat"
	Gemini    Wire = "gemini"
)

// Wires mirrors WIRES.
var Wires = []Wire{Messages, Responses, Chat, Gemini}

// Sealed is an opaque reasoning block only its origin protocol can replay.
type Sealed struct {
	By  string // "messages" | "responses"
	Raw any
}

// Part mirrors IRPart.
type Part struct {
	Kind      string // text | image | file | tool_call | tool_result | thinking
	Text      *string
	MediaType *string
	Data      *string
	URL       *string
	ID        *string
	Name      *string
	Args      *string
	CallID    *string
	IsError   *bool
	Images    []Part // nil = undefined
	Signature *string
	Sealed    *Sealed
	Custom    *bool
}

// Message mirrors IRMessage.
type Message struct {
	Role  string // user | assistant
	Parts []Part
}

// Tool mirrors IRTool.
type Tool struct {
	Name        string
	Description *string
	Schema      any
	Kind        string // function | custom
}

// ToolChoice mirrors IRToolChoice: Mode is auto|none|required, or Name is set.
type ToolChoice struct {
	Mode string
	Name *string
}

// Reasoning mirrors IRReasoning.
type Reasoning struct {
	Effort *string
	Budget *float64
	Off    *bool
}

// Request mirrors IRRequest.
type Request struct {
	Model             string
	System            []Part
	Messages          []Message
	Tools             []Tool
	ToolChoice        *ToolChoice
	ParallelToolCalls *bool
	MaxTokens         *float64
	Temperature       *float64
	TopP              *float64
	Stop              []string // nil = undefined
	Stream            bool
	Reasoning         *Reasoning
}
