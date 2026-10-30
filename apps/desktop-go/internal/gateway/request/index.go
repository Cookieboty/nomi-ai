package request

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/ir"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DecodeOptions mirrors DecodeOptions.
type DecodeOptions struct {
	Model  *string
	Stream bool
}

// DecodeRequest mirrors decodeRequest.
func DecodeRequest(wire ir.Wire, body any, opts DecodeOptions) *ir.Request {
	switch wire {
	case ir.Messages:
		return DecodeMessages(body)
	case ir.Responses:
		return DecodeResponses(body)
	case ir.Chat:
		return DecodeChat(body)
	default:
		return DecodeGemini(body, GeminiOpts{Model: opts.Model, Stream: opts.Stream})
	}
}

// EncodeRequest mirrors encodeRequest.
func EncodeRequest(wire ir.Wire, r *ir.Request, model *string, opts EncodeOptions) *u.Obj {
	switch wire {
	case ir.Messages:
		return EncodeMessages(r, model)
	case ir.Responses:
		return EncodeResponses(r, model)
	case ir.Chat:
		return EncodeChat(r, model, opts)
	default:
		return EncodeGemini(r)
	}
}

// ConvertOptions mirrors convertRequest's opts.
type ConvertOptions struct {
	DecodeOptions
	EncodeOptions
	UpstreamModel *string
}

// ConvertRequest mirrors convertRequest.
func ConvertRequest(from, to ir.Wire, body any, opts ConvertOptions) *u.Obj {
	return EncodeRequest(to, DecodeRequest(from, body, opts.DecodeOptions), opts.UpstreamModel, opts.EncodeOptions)
}
