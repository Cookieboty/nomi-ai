package upstream

import (
	"regexp"
	"strconv"
	"unicode/utf16"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/intent"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/ir"
	mreq "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/request"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/request"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var reV1 = regexp.MustCompile(`/v1$`)

// URLOpts is upstreamUrl's opts.
type URLOpts struct{ Stream, CountTokens bool }

// URL is upstreamUrl.
func URL(wire, base, model string, opts URLOpts) string {
	b := trailingSlashes.ReplaceAllString(base, "")
	switch wire {
	case "messages":
		v1 := b
		if !reV1.MatchString(b) {
			v1 = b + "/v1"
		}
		if opts.CountTokens {
			return v1 + "/messages/count_tokens"
		}
		return v1 + "/messages"
	case "responses":
		return b + "/responses"
	case "chat":
		return b + "/chat/completions"
	case "gemini":
		op := "generateContent"
		if opts.CountTokens {
			op = "countTokens"
		} else if opts.Stream {
			op = "streamGenerateContent?alt=sse"
		}
		return b + "/models/" + GeminiModelPath(model) + ":" + op
	}
	return "undefined"
}

var defaultAuth = map[string]string{"messages": "x-api-key", "responses": "bearer", "chat": "bearer", "gemini": "x-goog-api-key"}

// HeaderOpts is upstreamHeaders' opts. ClientHeaders values are string or []string.
type HeaderOpts struct {
	Stream        bool
	ClientHeaders map[string]any
	SameWire      bool
}

// Headers is upstreamHeaders: an ordered name → value object (JS key order).
func Headers(c *cand.Candidate, opts HeaderOpts) *u.Obj {
	h := u.NewObj("Content-Type", "application/json")
	if opts.Stream {
		h.Set("Accept", "text/event-stream")
	} else {
		h.Set("Accept", "application/json")
	}
	auth := defaultAuth[c.Wire]
	if d := c.Provider.Detected[c.Wire]; d != nil && d.Auth != "" {
		auth = d.Auth
	}
	if c.Key.Value != "" {
		switch auth {
		case "x-api-key":
			h.Set("x-api-key", c.Key.Value)
		case "x-goog-api-key":
			h.Set("x-goog-api-key", c.Key.Value)
		default:
			h.Set("Authorization", "Bearer "+c.Key.Value)
		}
	}
	header := func(name string) string {
		s, _ := opts.ClientHeaders[name].(string)
		return s
	}
	if c.Wire == "messages" {
		v := ""
		if opts.SameWire {
			v = header("anthropic-version")
		}
		if v == "" {
			v = "2023-06-01"
		}
		h.Set("anthropic-version", v)
		beta := ""
		if opts.SameWire {
			beta = header("anthropic-beta")
		}
		if beta != "" && !IsAnthropicOfficial(c) {
			beta = providers.FilterAnthropicBeta(beta)
		}
		if beta != "" {
			h.Set("anthropic-beta", beta)
		}
	}
	var ua string
	if c.Provider.UserAgent != nil {
		ua = *c.Provider.UserAgent
	} else if opts.SameWire {
		ua = header("user-agent")
	} else if q := providers.QuirksOf(c.Provider, c.Wire); q != nil {
		ua = q.UserAgent
	}
	if ua != "" {
		h.Set("User-Agent", ua)
	}
	if c.Provider.Headers != nil {
		h.Assign(c.Provider.Headers)
	}
	return h
}

// BodyOpts is upstreamBody's opts.
type BodyOpts struct {
	Stream        bool
	IngressModel  *string
	Notes         *[]string
	Client        string
	BindingEffort *string
}

// spread is `{ ...v }` for any JSON value.
func spread(v any) *u.Obj {
	switch x := v.(type) {
	case *u.Obj:
		return x.Clone()
	case []any:
		o := u.NewObj()
		for i, e := range x {
			o.Set(strconv.Itoa(i), e)
		}
		return o
	case string:
		o := u.NewObj()
		for i, c := range utf16.Encode([]rune(x)) {
			o.Set(strconv.Itoa(i), string(utf16.Decode([]uint16{c})))
		}
		return o
	}
	return u.NewObj()
}

// Body is upstreamBody; the error is UnsupportedParamError (strict models).
func Body(ingress string, c *cand.Candidate, body any, opts BodyOpts) (any, error) {
	var out any
	m := CandidateSpec(c)
	in := intent.ReadIntent(ingress, body, opts.Client)
	if ingress == c.Wire {
		if c.Wire == "gemini" {
			out = body
		} else {
			out = spread(body).Set("model", c.UpstreamModel)
		}
		bound := intent.WithBindingEffort(in, opts.BindingEffort)
		var efforts []string
		if xs, ok := at(m, "reasoning", "efforts").([]any); ok {
			for _, x := range xs {
				efforts = append(efforts, u.JSString(x))
			}
		}
		unsupported := in != nil && in.Source == "explicit" && in.Effort != "" && len(efforts) > 0 &&
			mreq.FitLevel(in.Effort, efforts) != in.Effort
		if bound != nil && bound.Source == "binding" {
			out = mreq.RenderReasoning(c.Wire, out, bound, m, opts.Notes).Body
		} else if unsupported {
			out = mreq.RenderReasoning(c.Wire, out, in, m, opts.Notes).Body
		}
		if c.CustomToolsAsFunctions && c.Wire == "responses" {
			converted := CustomToolsToFunctions(out)
			if converted != out && opts.Notes != nil {
				*opts.Notes = append(*opts.Notes, "custom 工具已改成函数发出（上游不支持 custom 工具）")
			}
			out = converted
		}
	} else {
		q := providers.QuirksOf(c.Provider, c.Wire)
		passback := (q != nil && q.ReasoningPassback != nil && *q.ReasoningPassback) || at(m, "reasoning", "passback") == "required"
		um := c.UpstreamModel
		out = request.ConvertRequest(ir.Wire(ingress), ir.Wire(c.Wire), body, request.ConvertOptions{
			DecodeOptions: request.DecodeOptions{Model: opts.IngressModel, Stream: opts.Stream},
			EncodeOptions: request.EncodeOptions{ReasoningPassback: passback},
			UpstreamModel: &um,
		})
		if eff := intent.WithBindingEffort(in, opts.BindingEffort); eff != nil {
			out = mreq.RenderReasoning(c.Wire, out, eff, m, opts.Notes).Body
		}
	}
	if c.Wire == "chat" && opts.Stream && u.IsObj(out) {
		out = out.(*u.Obj).Clone().Set("stream", true).Set("stream_options", u.NewObj("include_usage", true))
	}
	out, err := ApplyRequestFixes(c, out, opts.Notes)
	if err != nil {
		return nil, err
	}
	if len(c.Rectify) > 0 {
		var mo *float64
		if f, ok := at(m, "limits", "maxOutput").(float64); ok {
			mo = &f
		}
		notes := opts.Notes
		if notes == nil {
			notes = &[]string{}
		}
		out = route.ApplyRectifiers(c.Wire, out, c.Rectify, mo, notes)
	}
	if len(c.DropParams) > 0 && u.IsObj(out) {
		o := out.(*u.Obj).Clone()
		for _, k := range c.DropParams {
			o.Delete(k)
		}
		out = o
	}
	return out, nil
}
