package upstream

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	mreq "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/request"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// IsAnthropicOfficial is isAnthropicOfficial.
func IsAnthropicOfficial(c *cand.Candidate) bool { return providers.NativeOf(c) == "anthropic" }

// IsOpenAIOfficial is isOpenAIOfficial.
func IsOpenAIOfficial(c *cand.Candidate) bool { return providers.NativeOf(c) == "openai" }

// CandidateModel is candidateModel.
func CandidateModel(c *cand.Candidate) *config.RuntimeModel {
	id := c.ShortModel()
	for i := range c.Provider.Models {
		if c.Provider.Models[i].ID == id {
			return &c.Provider.Models[i]
		}
	}
	return nil
}

// ToolCount is toolCount.
func ToolCount(wire string, body any) int {
	if !u.IsObj(body) {
		return 0
	}
	tools, ok := body.(*u.Obj).Get("tools").([]any)
	if !ok {
		return 0
	}
	if wire != "gemini" {
		return len(tools)
	}
	n := 0
	for _, t := range tools {
		if u.IsObj(t) {
			if fns, ok := t.(*u.Obj).Get("functionDeclarations").([]any); ok {
				n += len(fns)
				continue
			}
		}
		n++
	}
	return n
}

// ToolLimitError is toolLimitError ("" = null).
func ToolLimitError(c *cand.Candidate, body any) string {
	if s := providers.ServerToolError(c, c.Wire, body); s != "" {
		return s
	}
	q := providers.QuirksOf(c.Provider, c.Wire)
	if q == nil || q.MaxTools == nil || !(*q.MaxTools > 0) {
		return ""
	}
	max := *q.MaxTools
	n := ToolCount(c.Wire, body)
	if float64(n) > max {
		return "当前供应商一次最多支持 " + u.FormatNumber(max) + " 个工具，这次请求带了 " + u.FormatNumber(float64(n)) + " 个，请减少 MCP 工具"
	}
	return ""
}

// ApplyRequestFixes is applyRequestFixes; the error is UnsupportedParamError.
func ApplyRequestFixes(c *cand.Candidate, body any, notes *[]string) (any, error) {
	if !u.IsObj(body) {
		return body, nil
	}
	if notes == nil {
		notes = &[]string{}
	}
	o := body.(*u.Obj).Clone()
	if _, err := mreq.ModelRequest(c.Wire, o, CandidateSpec(c), notes); err != nil {
		return nil, err
	}
	providers.ProviderRequest(c, o, notes)
	return o, nil
}

// CandidateSpec is candidateSpec.
func CandidateSpec(c *cand.Candidate) *u.Obj {
	if c.Model != nil {
		return c.Model
	}
	return models.EffectiveModel(c.Provider, c.ShortModel(), nil, models.EffectiveOpts{})
}

// at is `o?.a?.b` over plain objects.
func at(v any, path ...string) any {
	for _, k := range path {
		if !u.IsObj(v) {
			return nil
		}
		v = v.(*u.Obj).Get(k)
	}
	return v
}
