package openai

import (
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type inputArgs struct {
	prompt            []llm.Message
	systemMessageMode string
	optionsName       string
	fileIDPrefixes    []string
	store             bool
	hasPreviousID     bool
	passThroughFiles  bool
	outputSchemaTools map[string]bool
}

func cacheBreakpoint(po *util.Obj, name string) any {
	return get(objAt(po, name), "promptCacheBreakpoint")
}

func withBreakpoint(o *util.Obj, bp any) *util.Obj {
	if bp != nil {
		o.Set("prompt_cache_breakpoint", bp)
	}
	return o
}

func scalarOutput(v string, bp any) any {
	if bp == nil {
		return v
	}
	return []any{util.NewObj("type", "input_text", "text", v, "prompt_cache_breakpoint", bp)}
}

func dataURL(p llm.Part) (string, error) {
	mt, err := llm.ResolveFullMediaType(p)
	if err != nil {
		return "", err
	}
	return "data:" + mt + ";base64," + llm.ToBase64(p.Data), nil
}

func resolveReference(ref *util.Obj, provider string) (string, error) {
	if s, ok := get(ref, provider).(string); ok {
		return s, nil
	}
	return "", &llm.InvalidArgumentError{Argument: "reference", Message: "No provider reference found for provider '" + provider + "'"}
}

func isFileID(p llm.Part, prefixes []string) bool {
	if !p.Data.IsString {
		return false
	}
	for _, pre := range prefixes {
		if strings.HasPrefix(p.Data.Base64, pre) {
			return true
		}
	}
	return false
}

// toolOutput is convertFunctionToolResultOutput (no outputSchema tools).
func toolOutput(o *llm.ToolResultOutput, bp any, name string, hasOS bool, warnings *[]llm.Warning) (any, error) {
	switch o.Type {
	case "text":
		s, _ := o.Value.(string)
		if hasOS {
			s = util.Stringify(s)
		}
		return scalarOutput(s, bp), nil
	case "error-text", "error-json":
		return scalarOutput(util.Stringify(util.NewObj("error", o.Value)), bp), nil
	case "execution-denied":
		r := "Tool call execution denied."
		if o.Reason != nil {
			r = *o.Reason
		}
		if hasOS {
			r = util.Stringify(r)
		}
		return scalarOutput(r, bp), nil
	case "json":
		return scalarOutput(util.Stringify(o.Value), bp), nil
	case "content":
		out := []any{}
		for _, it := range o.Content {
			ibp := cacheBreakpoint(it.ProviderOptions, name)
			switch it.Type {
			case "text":
				out = append(out, withBreakpoint(util.NewObj("type", "input_text", "text", it.Text), ibp))
			case "file":
				isImage := llm.TopLevelMediaType(it.MediaType) == "image"
				detail := orUndef(get(objAt(it.ProviderOptions, name), "imageDetail"))
				switch it.Data.Type {
				case "reference":
					id, err := resolveReference(it.Data.Reference, name)
					if err != nil {
						return nil, err
					}
					if isImage {
						out = append(out, withBreakpoint(util.NewObj("type", "input_image", "file_id", id, "detail", detail), ibp))
					} else {
						out = append(out, withBreakpoint(util.NewObj("type", "input_file", "file_id", id), ibp))
					}
				case "data":
					u, err := dataURL(it)
					if err != nil {
						return nil, err
					}
					if isImage {
						out = append(out, withBreakpoint(util.NewObj("type", "input_image", "image_url", u, "detail", detail), ibp))
					} else {
						fn := it.Filename
						if fn == "" {
							fn = "data"
						}
						out = append(out, withBreakpoint(util.NewObj("type", "input_file", "filename", fn, "file_data", u), ibp))
					}
				case "url":
					if isImage {
						out = append(out, withBreakpoint(util.NewObj("type", "input_image", "image_url", it.Data.URL, "detail", detail), ibp))
					} else {
						out = append(out, withBreakpoint(util.NewObj("type", "input_file", "file_url", it.Data.URL), ibp))
					}
				default:
					*warnings = append(*warnings, llm.Warning{Type: "other", Message: "unsupported tool content part type: file with data type: " + it.Data.Type})
				}
			default:
				*warnings = append(*warnings, llm.Warning{Type: "other", Message: "unsupported tool content part type: " + it.Type})
			}
		}
		return out, nil
	}
	return util.Undefined, nil
}

var reasoningOptsSchema = llm.Obj(
	llm.F{Key: "itemId", S: llm.Nullish(llm.Str())},
	llm.F{Key: "reasoningEncryptedContent", S: llm.Nullish(llm.Str())},
)

func mapCaller(c *util.Obj) any {
	if c == nil {
		return nil
	}
	if c.Get("type") == "program" {
		return util.NewObj("type", "program", "caller_id", c.Get("callerId"))
	}
	return c
}

// convertInput is convertToOpenAIResponsesInput (hasConversation=false, no
// provider tools; parallel result groups: D-B5-P-7).
func convertInput(a inputArgs) ([]any, []llm.Warning, error) {
	input := []any{}
	var warnings []llm.Warning
	name := a.optionsName
	processedApprovals := map[string]bool{}
	for _, msg := range a.prompt {
		switch msg.Role {
		case "system":
			if eff := get(objAt(msg.ProviderOptions, name), "reasoningEffortUpdate"); eff != nil {
				return nil, nil, &llm.UnsupportedFunctionalityError{Functionality: "Message-level reasoningEffortUpdate",
					Message: "Message-level reasoningEffortUpdate is not supported by the Go runtime (D-B5-P-7)."}
			}
			switch a.systemMessageMode {
			case "system", "developer":
				bp := cacheBreakpoint(msg.ProviderOptions, name)
				input = append(input, util.NewObj("role", a.systemMessageMode, "content", scalarOutput(msg.Text, bp)))
			case "remove":
				warnings = append(warnings, llm.Warning{Type: "other", Message: "system messages are removed for this model"})
			}
		case "user":
			content := []any{}
			for i, p := range msg.Parts {
				bp := cacheBreakpoint(p.ProviderOptions, name)
				switch p.Type {
				case "text":
					content = append(content, withBreakpoint(util.NewObj("type", "input_text", "text", p.Text), bp))
				case "file":
					detail := orUndef(get(objAt(p.ProviderOptions, name), "imageDetail"))
					isImage := llm.TopLevelMediaType(p.MediaType) == "image"
					switch p.Data.Type {
					case "reference":
						id, err := resolveReference(p.Data.Reference, name)
						if err != nil {
							return nil, nil, err
						}
						if isImage {
							content = append(content, withBreakpoint(util.NewObj("type", "input_image", "file_id", id, "detail", detail), bp))
						} else {
							content = append(content, withBreakpoint(util.NewObj("type", "input_file", "file_id", id), bp))
						}
					case "text":
						return nil, nil, llm.NewUnsupported("text file parts")
					case "url", "data":
						if isImage {
							o := util.NewObj("type", "input_image")
							switch {
							case p.Data.Type == "url":
								o.Set("image_url", p.Data.URL)
							case isFileID(p, a.fileIDPrefixes):
								o.Set("file_id", p.Data.Base64)
							default:
								u, err := dataURL(p)
								if err != nil {
									return nil, nil, err
								}
								o.Set("image_url", u)
							}
							content = append(content, withBreakpoint(o.Set("detail", detail), bp))
							continue
						}
						if p.Data.Type == "url" {
							content = append(content, withBreakpoint(util.NewObj("type", "input_file", "file_url", p.Data.URL), bp))
							continue
						}
						mt, err := llm.ResolveFullMediaType(p)
						if err != nil {
							return nil, nil, err
						}
						if mt != "application/pdf" && !a.passThroughFiles {
							return nil, nil, llm.NewUnsupported("file part media type " + mt)
						}
						o := util.NewObj("type", "input_file")
						if isFileID(p, a.fileIDPrefixes) {
							o.Set("file_id", p.Data.Base64)
						} else {
							fn := p.Filename
							if fn == "" {
								fn = "part-" + strconv.Itoa(i)
								if mt == "application/pdf" {
									fn += ".pdf"
								}
							}
							o.Set("filename", fn).Set("file_data", "data:"+mt+";base64,"+llm.ToBase64(p.Data))
						}
						content = append(content, withBreakpoint(o, bp))
					}
				default:
					content = append(content, nil)
				}
			}
			input = append(input, util.NewObj("role", "user", "content", content))
		case "assistant":
			reasoning := map[string]*util.Obj{}
			emittedText := map[string]bool{}
			for _, p := range msg.Parts {
				po := objAt(p.ProviderOptions, name)
				switch p.Type {
				case "text":
					id, hasID := get(po, "itemId").(string)
					if a.store && hasID {
						if !emittedText[id] {
							emittedText[id] = true
							input = append(input, util.NewObj("type", "item_reference", "id", id))
						}
						continue
					}
					o := util.NewObj("role", "assistant", "content", p.Text)
					if ph := get(po, "phase"); ph != nil {
						o.Set("phase", ph)
					}
					input = append(input, o)
				case "tool-call":
					if p.ProviderExec {
						return nil, nil, llm.NewUnsupported("provider-executed tool calls (Go runtime)")
					}
					args := "{}"
					if p.Input != nil {
						args = util.Stringify(p.Input)
					}
					o := util.NewObj("type", "function_call", "call_id", p.ToolCallID, "name", p.ToolName, "arguments", args)
					if v := get(po, "async"); v != nil {
						o.Set("async", v)
					}
					if v := get(po, "namespace"); v != nil {
						o.Set("namespace", v)
					}
					if c := mapCaller(objAt(po, "caller")); c != nil {
						o.Set("caller", c)
					}
					input = append(input, o)
				case "reasoning":
					var opts *util.Obj
					if v := get(p.ProviderOptions, name); v != nil {
						x, err := llm.Validate(v, reasoningOptsSchema)
						if err != nil {
							return nil, nil, &llm.InvalidArgumentError{Argument: "providerOptions", Message: "invalid " + name + " provider options"}
						}
						opts = x.(*util.Obj)
					}
					rid, hasID := get(opts, "itemId").(string)
					enc := get(opts, "reasoningEncryptedContent")
					if a.hasPreviousID && hasID {
						continue
					}
					if hasID {
						rm := reasoning[rid]
						if a.store {
							if rm == nil {
								input = append(input, util.NewObj("type", "item_reference", "id", rid))
								reasoning[rid] = util.NewObj("type", "reasoning", "id", rid, "summary", []any{})
							}
							continue
						}
						summary := []any{}
						if p.Text != "" {
							summary = append(summary, util.NewObj("type", "summary_text", "text", p.Text))
						} else if rm != nil {
							warnings = append(warnings, llm.Warning{Type: "other", Message: "Cannot append empty reasoning part to existing reasoning sequence. Skipping reasoning part: " + partJSON(p) + "."})
						}
						if rm == nil {
							rm = util.NewObj("type", "reasoning", "id", rid, "encrypted_content", orUndef(enc), "summary", summary)
							reasoning[rid] = rm
							input = append(input, rm)
						} else {
							rm.Set("summary", append(rm.Get("summary").([]any), summary...))
							if enc != nil {
								rm.Set("encrypted_content", enc)
							}
						}
						continue
					}
					if enc != nil {
						summary := []any{}
						if p.Text != "" {
							summary = append(summary, util.NewObj("type", "summary_text", "text", p.Text))
						}
						input = append(input, util.NewObj("type", "reasoning", "encrypted_content", enc, "summary", summary))
					} else {
						warnings = append(warnings, llm.Warning{Type: "other", Message: "Non-OpenAI reasoning parts are not supported. Skipping reasoning part: " + partJSON(p) + "."})
					}
				}
			}
		case "tool":
			for _, p := range msg.Parts {
				if p.Type == "tool-approval-response" {
					if processedApprovals[p.ApprovalID] {
						continue
					}
					processedApprovals[p.ApprovalID] = true
					if a.store && !a.hasPreviousID {
						input = append(input, util.NewObj("type", "item_reference", "id", p.ApprovalID))
					}
					input = append(input, util.NewObj("type", "mcp_approval_response", "approval_request_id", p.ApprovalID, "approve", p.Approved))
					continue
				}
				out := p.Output
				if out == nil {
					out = &llm.ToolResultOutput{Type: "text", Value: ""}
				}
				if out.Type == "execution-denied" {
					if s, _ := get(objAt(out.ProviderOptions, "openai"), "approvalId").(string); s != "" {
						continue
					}
				}
				po := objAt(p.ProviderOptions, name)
				caller := objAt(po, "caller")
				if out.Type == "execution-denied" && caller != nil && caller.Get("type") == "program" {
					return nil, nil, llm.NewUnsupported("execution-denied results for programmatic tool calls")
				}
				var bp any
				if out.Type != "content" {
					bp = cacheBreakpoint(out.ProviderOptions, name)
					if bp == nil {
						bp = cacheBreakpoint(p.ProviderOptions, name)
					}
				}
				v, err := toolOutput(out, bp, name, a.outputSchemaTools[p.ToolName], &warnings)
				if err != nil {
					return nil, nil, err
				}
				o := util.NewObj("type", "function_call_output", "call_id", p.ToolCallID, "output", v)
				if c := mapCaller(caller); c != nil {
					o.Set("caller", c)
				}
				input = append(input, o)
			}
		}
	}
	if !a.store {
		has := false
		for _, it := range input {
			if o, ok := it.(*util.Obj); ok && o.Get("type") == "reasoning" && o.Get("encrypted_content") == nil {
				has = true
			}
		}
		if has {
			warnings = append(warnings, llm.Warning{Type: "other", Message: "Reasoning parts without encrypted content are not supported when store is false. Skipping reasoning parts."})
			kept := []any{}
			for _, it := range input {
				if o, ok := it.(*util.Obj); ok && o.Get("type") == "reasoning" && o.Get("encrypted_content") == nil {
					continue
				}
				kept = append(kept, it)
			}
			input = kept
		}
	}
	return input, warnings, nil
}

// partJSON approximates JSON.stringify(part) for a reasoning prompt part.
func partJSON(p llm.Part) string {
	o := util.NewObj("type", "reasoning", "text", p.Text)
	if p.ProviderOptions != nil {
		o.Set("providerOptions", p.ProviderOptions)
	}
	return util.Stringify(o)
}
