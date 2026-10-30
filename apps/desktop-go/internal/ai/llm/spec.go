// Package llm mirrors the parts of @ai-sdk/provider (LanguageModelV4 spec,
// errors) and @ai-sdk/provider-utils (postJsonToApi, SSE parsing, headers)
// that Node's AI runtime (apps/desktop-electron/internal/ai-runtime/src/ai-sdk/AiSdkLlmProvider.ts)
// reaches through the Vercel AI SDK. Protocol adapters live in subpackages:
//
//	llm/compatible  ← @ai-sdk/openai-compatible chatModel   (protocol openai-chat)
//	llm/openai      ← @ai-sdk/openai .responses()           (protocol openai-responses)
//	llm/anthropic   ← @ai-sdk/anthropic .messages()         (protocol anthropic)
//
// No vendor SDKs: net/http + a port of eventsource-parser (see sse.go).
//
// JSON values follow gateway/util's value space (nil | bool | float64 | string
// | []any | *util.Obj) so request bodies serialize exactly like JSON.stringify.
package llm

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// LanguageModel is LanguageModelV4 (doGenerate / doStream). Abort = ctx cancel
// (AbortSignal); the returned error / error parts carry *AbortError then.
type LanguageModel interface {
	Provider() string
	ModelID() string
	DoGenerate(ctx context.Context, opts CallOptions) (*GenerateResult, error)
	// DoStream returns once response headers are in (like the SDK's doStream
	// promise). Stream is closed after the final part; it is drained by the caller.
	DoStream(ctx context.Context, opts CallOptions) (*StreamResult, error)
}

// ProviderOptions / ProviderMetadata: Record<provider, JSONObject>.
type ProviderOptions = *util.Obj
type ProviderMetadata = *util.Obj

// CallOptions is LanguageModelV4CallOptions (abortSignal → ctx).
// Optional numbers are pointers (nil = undefined).
type CallOptions struct {
	Prompt           []Message
	MaxOutputTokens  *float64
	Temperature      *float64
	StopSequences    []string
	TopP             *float64
	TopK             *float64
	PresencePenalty  *float64
	FrequencyPenalty *float64
	ResponseFormat   *ResponseFormat
	Seed             *float64
	Tools            []Tool
	ToolChoice       *ToolChoice
	IncludeRawChunks bool
	// Headers: Record<string, string | undefined>; keys keep insertion order.
	Headers         []Header
	Reasoning       string // "" = undefined; provider-default|none|minimal|low|medium|high|xhigh|max
	ProviderOptions ProviderOptions
}

// Header is one header entry; Undefined mirrors `{ k: undefined }`.
type Header struct {
	Name, Value string
	Undefined   bool
}

type ResponseFormat struct {
	Type        string // text | json
	Schema      any
	Name        string
	Description string
}

// Message is LanguageModelV4Message. System messages use Text; others use Parts.
type Message struct {
	Role            string // system | user | assistant | tool
	Text            string // role=system content
	Parts           []Part
	ProviderOptions ProviderOptions
}

// Part is a prompt content part:
// text | reasoning | file | tool-call | tool-result | tool-approval-response | custom | reasoning-file.
type Part struct {
	Type            string
	Text            string
	Filename        string
	Data            FileData // file / reasoning-file
	MediaType       string
	ToolCallID      string
	ToolName        string
	Input           any // tool-call input (JSON value)
	ProviderExec    bool
	Output          *ToolResultOutput
	ApprovalID      string
	Approved        bool
	Reason          string
	Kind            string
	ProviderOptions ProviderOptions
}

// FileData is SharedV4FileData: type data (Bytes or Base64) | url | reference | text.
type FileData struct {
	Type      string // data | url | reference | text
	Bytes     []byte
	Base64    string // data given as string (base64 or data: URL text as the SDK saw it)
	IsString  bool
	URL       string
	Reference *util.Obj
	Text      string
}

// ToolResultOutput: text | json | execution-denied | error-text | error-json | content.
type ToolResultOutput struct {
	Type            string
	Value           any // string for text/error-text, JSON for json/error-json
	Reason          *string
	Content         []Part // type=content: text | file | custom
	ProviderOptions ProviderOptions
}

// Tool is a function tool (type=function) or provider tool (type=provider).
type Tool struct {
	Type            string // function | provider
	Name            string
	Description     *string
	InputSchema     any
	InputExamples   []any
	Strict          *bool
	ID              string // provider tool id
	Args            *util.Obj
	ProviderOptions ProviderOptions
}

type ToolChoice struct {
	Type     string // auto | none | required | tool
	ToolName string
}

// FinishReason is LanguageModelV4FinishReason.
type FinishReason struct {
	Unified string  // stop | length | content-filter | tool-calls | error | other
	Raw     *string // nil = undefined
}

// Num is an optional number (nil = undefined).
type Num = *float64

// Usage is LanguageModelV4Usage.
type Usage struct {
	InputTotal, InputNoCache, InputCacheRead, InputCacheWrite Num
	OutputTotal, OutputText, OutputReasoning                  Num
	Raw                                                       any // JSONObject or nil
}

// Warning is SharedV4Warning.
type Warning struct {
	Type    string // unsupported | compatibility | deprecated | other
	Feature string
	Details *string
	Setting string
	Message string
}

// ResponseMetadata is LanguageModelV4ResponseMetadata (Timestamp: epoch ms).
type ResponseMetadata struct {
	ID        *string
	Timestamp *float64
	ModelID   *string
}

// Content is one generate-result content item (same shapes as stream parts).
type Content = StreamPart

// StreamPart is one LanguageModelV4StreamPart; Type selects the used fields.
type StreamPart struct {
	Type             string
	ID               string
	Delta            string
	Text             string // text / reasoning content
	ToolName         string
	ToolCallID       string
	Input            string // tool-call input (JSON text)
	ProviderExecuted *bool
	Dynamic          *bool
	Title            *string
	Result           any
	IsError          *bool
	Preliminary      *bool
	MediaType        string
	Data             *FileData
	SourceType       string
	URL              string
	Filename         *string
	ApprovalID       string
	Kind             string
	Warnings         []Warning
	Meta             *ResponseMetadata // response-metadata
	Usage            *Usage
	FinishReason     *FinishReason
	ProviderMetadata ProviderMetadata
	RawValue         any
	Err              error
}

// GenerateResult is LanguageModelV4GenerateResult.
type GenerateResult struct {
	Content          []Content
	FinishReason     FinishReason
	Usage            Usage
	ProviderMetadata ProviderMetadata
	RequestBody      string // request.body (JSON text as sent)
	Response         ResponseMetadata
	ResponseHeaders  map[string]string
	ResponseBody     any
	Warnings         []Warning
}

// StreamResult is LanguageModelV4StreamResult.
type StreamResult struct {
	Stream          <-chan StreamPart
	RequestBody     string
	ResponseHeaders map[string]string
}

// PartStreamError is not an SDK part: it is the ReadableStream itself erroring
// (controller.error / a rejected reader.read()), e.g. abort mid-stream or a
// body read failure. It is always the last item; Err holds the thrown error.
// SDK `error` parts (Type "error", Err = part.error) are ordinary parts.
const PartStreamError = "__stream-error"
