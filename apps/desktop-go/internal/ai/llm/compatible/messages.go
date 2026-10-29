package compatible

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// meta is getOpenAIMetadata: providerOptions.openaiCompatible ?? {}.
func meta(po *util.Obj) *util.Obj {
	if o, ok := get(po, "openaiCompatible").(*util.Obj); ok {
		return o
	}
	return nil
}

func spread(dst, src *util.Obj) *util.Obj {
	if src != nil {
		dst.Assign(src)
	}
	return dst
}

func audioFormat(mt string) string {
	switch mt {
	case "audio/wav":
		return "wav"
	case "audio/mp3", "audio/mpeg":
		return "mp3"
	}
	return ""
}

func dataURL(p llm.Part) (string, error) {
	if p.Data.Type == "url" {
		return p.Data.URL, nil
	}
	mt, err := llm.ResolveFullMediaType(p)
	if err != nil {
		return "", err
	}
	return "data:" + mt + ";base64," + llm.ToBase64(p.Data), nil
}

func contentPart(p llm.Part) (*util.Obj, error) {
	pm := meta(p.ProviderOptions)
	switch p.Type {
	case "text":
		return spread(util.NewObj("type", "text", "text", p.Text), pm), nil
	case "file":
		switch p.Data.Type {
		case "reference":
			return nil, llm.NewUnsupported("file parts with provider references")
		case "text":
			return nil, llm.NewUnsupported("text file parts")
		}
		switch llm.TopLevelMediaType(p.MediaType) {
		case "image":
			u, err := dataURL(p)
			if err != nil {
				return nil, err
			}
			return spread(util.NewObj("type", "image_url", "image_url", util.NewObj("url", u)), pm), nil
		case "video":
			u, err := dataURL(p)
			if err != nil {
				return nil, err
			}
			return spread(util.NewObj("type", "video_url", "video_url", util.NewObj("url", u)), pm), nil
		case "audio":
			if p.Data.Type == "url" {
				return nil, llm.NewUnsupported("audio file parts with URLs")
			}
			mt, err := llm.ResolveFullMediaType(p)
			if err != nil {
				return nil, err
			}
			f := audioFormat(mt)
			if f == "" {
				return nil, llm.NewUnsupported("audio media type " + mt)
			}
			return spread(util.NewObj("type", "input_audio", "input_audio", util.NewObj("data", llm.ToBase64(p.Data), "format", f)), pm), nil
		case "application":
			if p.Data.Type == "url" {
				return nil, llm.NewUnsupported("PDF file parts with URLs")
			}
			mt, err := llm.ResolveFullMediaType(p)
			if err != nil {
				return nil, err
			}
			if mt != "application/pdf" {
				return nil, llm.NewUnsupported("file part media type " + mt)
			}
			fn := p.Filename
			if fn == "" {
				fn = "document.pdf"
			}
			return spread(util.NewObj("type", "file", "file", util.NewObj("filename", fn,
				"file_data", "data:application/pdf;base64,"+llm.ToBase64(p.Data))), pm), nil
		case "text":
			var text string
			switch {
			case p.Data.Type == "url":
				text = p.Data.URL
			case p.Data.IsString:
				var d util.TextDecoder
				text = d.Decode(llm.Base64ToBytes(p.Data.Base64)) + d.Flush()
			default:
				var d util.TextDecoder
				text = d.Decode(p.Data.Bytes) + d.Flush()
			}
			return spread(util.NewObj("type", "text", "text", text), pm), nil
		}
		return nil, llm.NewUnsupported("file part media type " + p.MediaType)
	}
	return nil, llm.NewUnsupported("part type " + p.Type)
}

// convertMessages is convertToOpenAICompatibleChatMessages
// (supportsMultiPartToolContent false).
func convertMessages(prompt []llm.Message, key string) ([]any, error) {
	out := []any{}
	for _, msg := range prompt {
		md := meta(msg.ProviderOptions)
		switch msg.Role {
		case "system":
			out = append(out, spread(util.NewObj("role", "system", "content", msg.Text), md))
		case "user":
			if len(msg.Parts) == 1 && msg.Parts[0].Type == "text" {
				out = append(out, spread(util.NewObj("role", "user", "content", msg.Parts[0].Text), meta(msg.Parts[0].ProviderOptions)))
				continue
			}
			parts := []any{}
			for _, p := range msg.Parts {
				c, err := contentPart(p)
				if err != nil {
					return nil, err
				}
				parts = append(parts, c)
			}
			out = append(out, spread(util.NewObj("role", "user", "content", parts), md))
		case "assistant":
			text, reasoning := "", ""
			calls := []any{}
			for _, p := range msg.Parts {
				switch p.Type {
				case "text":
					text += p.Text
				case "reasoning":
					reasoning += p.Text
				case "tool-call":
					var sigv any
					if o, ok := get(p.ProviderOptions, key).(*util.Obj); ok {
						sigv = o.Get("thoughtSignature")
					}
					if sigv == nil {
						if o, ok := get(p.ProviderOptions, "google").(*util.Obj); ok {
							sigv = o.Get("thoughtSignature")
						}
					}
					c := util.NewObj("id", p.ToolCallID, "type", "function",
						"function", util.NewObj("name", p.ToolName, "arguments", util.Stringify(p.Input)))
					spread(c, meta(p.ProviderOptions))
					if util.Truthy(sigv) {
						c.Set("extra_content", util.NewObj("google", util.NewObj("thought_signature", util.JSString(sigv))))
					}
					calls = append(calls, c)
				}
			}
			a := util.NewObj("role", "assistant")
			if len(calls) > 0 {
				if text == "" {
					a.Set("content", nil)
				} else {
					a.Set("content", text)
				}
			} else {
				a.Set("content", text)
			}
			if reasoning != "" {
				a.Set("reasoning_content", reasoning)
			}
			if len(calls) > 0 {
				a.Set("tool_calls", calls)
			} else {
				a.Set("tool_calls", util.Undefined)
			}
			out = append(out, spread(a, md))
		case "tool":
			for _, p := range msg.Parts {
				if p.Type == "tool-approval-response" || p.Output == nil {
					continue
				}
				var cv any
				switch p.Output.Type {
				case "text", "error-text":
					cv = p.Output.Value
				case "execution-denied":
					if p.Output.Reason != nil {
						cv = *p.Output.Reason
					} else {
						cv = "Tool call execution denied."
					}
				default: // json | error-json | content
					cv = util.Stringify(p.Output.Value)
				}
				out = append(out, spread(util.NewObj("role", "tool", "tool_call_id", p.ToolCallID, "content", cv), meta(p.ProviderOptions)))
			}
		}
	}
	return out, nil
}
