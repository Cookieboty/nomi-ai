// Package shared mirrors packages/cli-plugins/src/shared: helpers every CLI's
// stream / transcript parser shares.
package shared

import (
	"math"
	"regexp"
	"strings"

	. "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Clip limits (shared/stream.ts).
const (
	MaxInputStr = 2000
	MaxOutput   = 6000
	MaxThinking = 8000
)

var (
	reDataImageB64 = regexp.MustCompile(`(?i)^data:image/[\w.+-]+;base64,`)
	reHTTPS        = regexp.MustCompile(`(?i)^https://`)
	reDataImage    = regexp.MustCompile(`(?i)^data:image/`)
	reB64          = regexp.MustCompile(`(?i)^[a-z0-9+/=\r\n]+$`)
)

// ImageRefs mirrors imageRefs.
func ImageRefs(value any, out []string, depth int, allowHTTPS bool) []string {
	if depth > 6 || value == nil {
		return out
	}
	switch v := value.(type) {
	case string:
		if reDataImageB64.MatchString(util.JSIText(v)) || (allowHTTPS && reHTTPS.MatchString(util.JSIText(v))) {
			out = append(out, v)
		}
		return out
	case []any:
		for _, item := range v {
			out = ImageRefs(item, out, depth+1, allowHTTPS)
		}
		return out
	case *util.Obj:
		obj := v
		typ := ""
		if s, ok := obj.Get("type").(string); ok {
			typ = util.JSLower(s)
		}
		var source *util.Obj
		if s, ok := obj.Get("source").(*util.Obj); ok {
			source = s
		}
		mediaType := "image/png"
		if s, ok := obj.Get("media_type").(string); ok {
			mediaType = s
		} else if s, ok := obj.Get("mime_type").(string); ok {
			mediaType = s
		} else if s, ok := source.Get("media_type").(string); ok && source != nil {
			mediaType = s
		}
		var b64 string
		if s, ok := obj.Get("b64_json").(string); ok {
			b64 = s
		} else if s, ok := obj.Get("base64").(string); ok {
			b64 = s
		} else if s, ok := obj.Get("data").(string); ok && (strings.Contains(typ, "image") || util.IsStr(obj.Get("media_type"))) {
			b64 = s
		} else if s, ok := source.Get("data").(string); ok && source != nil {
			b64 = s
		}
		if b64 != "" && reB64.MatchString(util.JSIText(b64)) {
			out = append(out, "data:"+mediaType+";base64,"+CollapseWS(b64, ""))
		}
		url := obj.Get("url")
		if url == nil {
			if io, ok := obj.Get("image_url").(*util.Obj); ok {
				url = io.Get("url")
			} else {
				url = obj.Get("image_url")
			}
		}
		if s, ok := url.(string); ok && (reDataImage.MatchString(util.JSIText(s)) || (allowHTTPS && reHTTPS.MatchString(util.JSIText(s)))) {
			out = append(out, s)
		}
		if source != nil {
			out = ImageRefs(source, out, depth+1, allowHTTPS)
		}
		if strings.Contains(typ, "image") || strings.Contains(typ, "photo") || obj.Has("images") || obj.Has("generated_images") {
			out = ImageRefs(Coalesce(obj.Get("images"), obj.Get("generated_images"), obj.Get("data"), obj.Get("content")), out, depth+1,
				allowHTTPS || obj.Has("images") || obj.Has("generated_images") || strings.Contains(typ, "image"))
		}
		return out
	}
	return out
}

// ImageMarkdown mirrors imageMarkdown.
func ImageMarkdown(value any, allowHTTPS bool) string {
	refs := ImageRefs(value, nil, 0, allowHTTPS)
	seen := map[string]bool{}
	parts := []string{}
	for _, r := range refs {
		if seen[r] {
			continue
		}
		seen[r] = true
		parts = append(parts, "![Generated image "+util.FormatNumber(float64(len(parts)+1))+"]("+r+")")
	}
	return strings.Join(parts, "\n\n")
}

// TextWithImage mirrors textWithImage.
func TextWithImage(text, image string) string {
	if image == "" {
		return text
	}
	if text != "" {
		return text + "\n\n" + image
	}
	return image
}

// BlockText mirrors blockText.
func BlockText(value any, depth int) string {
	if depth > 6 || value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, x := range v {
			b.WriteString(BlockText(x, depth+1))
		}
		return b.String()
	case *util.Obj:
		typ := util.Str(v.Get("type"))
		if typ == "text" || typ == "output_text" || typ == "input_text" {
			return util.Str(v.Get("text"))
		}
		for _, key := range []string{"content", "parts", "output", "result"} {
			if v.Has(key) {
				if t := BlockText(v.Get(key), depth+1); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

// ImageEvent mirrors imageEvent.
func ImageEvent(value any, allowHTTPS, assumeBase64 bool) []Ev {
	candidate := value
	if s, ok := value.(string); ok && assumeBase64 && !reDataImage.MatchString(util.JSIText(s)) && !reHTTPS.MatchString(util.JSIText(s)) {
		candidate = util.NewObj("b64_json", s)
	}
	image := ImageMarkdown(candidate, allowHTTPS)
	if image != "" {
		return []Ev{O("type", "text-delta", "text", image+"\n\n")}
	}
	return nil
}

// Clip mirrors clip.
func Clip(s string, n int) string {
	if l := Len(s); l > n {
		return Slice0(s, n) + "\n… (+" + util.FormatNumber(float64(l-n)) + ")"
	}
	return s
}

// ClipDeep mirrors clipDeep.
func ClipDeep(v any, depth int) any {
	if s, ok := v.(string); ok {
		return Clip(s, MaxInputStr)
	}
	if depth > 5 || v == nil {
		return v
	}
	switch x := v.(type) {
	case []any:
		n := len(x)
		if n > 50 {
			n = 50
		}
		out := make([]any, n)
		for i := 0; i < n; i++ {
			out[i] = ClipDeep(x[i], depth+1)
		}
		return out
	case *util.Obj:
		out := util.NewObj()
		for i, k := range x.Keys() {
			if i >= 40 {
				break
			}
			out.Set(k, ClipDeep(x.Get(k), depth+1))
		}
		return out
	}
	return v
}

// InputText mirrors inputText (nil = undefined).
func InputText(v any) *string {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		if x == "" {
			return nil
		}
		s := Clip(x, MaxInputStr)
		return &s
	case *util.Obj:
		if x.Len() == 0 {
			return nil
		}
	case []any:
	default:
		s := util.JSString(v)
		return &s
	}
	s := util.Stringify(ClipDeep(v, 0))
	return &s
}

// OutputText mirrors outputText.
func OutputText(v any) *string {
	var s string
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		s = x
	case []any:
		parts := []string{}
		for _, c := range x {
			t := ""
			if o, ok := c.(*util.Obj); ok {
				if tx, ok := o.Get("text").(string); ok {
					t = tx
				}
			} else if tx, ok := c.(string); ok {
				t = tx
			}
			if t != "" {
				parts = append(parts, t)
			}
		}
		s = strings.Join(parts, "\n")
		if s == "" {
			return nil
		}
	case *util.Obj:
		s = util.Stringify(x)
	default:
		s = util.JSString(v)
	}
	if s == "" {
		return nil
	}
	r := Clip(s, MaxOutput)
	return &r
}

// Num mirrors num: a finite non-negative number or undefined.
func Num(v any) *float64 {
	if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 {
		return &f
	}
	return nil
}

// ParseUsage mirrors parseUsage (nil = undefined).
func ParseUsage(usage any, costUsd, durationMs any) Ev {
	u := util.AsObj(usage)
	pick := func(keys ...string) *float64 {
		for _, k := range keys {
			if v := Num(u.Get(k)); v != nil {
				return v
			}
		}
		return nil
	}
	out := util.NewObj()
	WithOpt(out,
		"inputTokens", pick("input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
		"outputTokens", pick("output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
		"cacheReadTokens", pick("cache_read_input_tokens", "cached_input_tokens", "cacheReadTokens", "cachedInputTokens", "cachedReadTokens"),
		"costUsd", Num(costUsd),
		"durationMs", Num(durationMs),
	)
	if out.Len() == 0 {
		return nil
	}
	return out
}

// AcpMetaContext mirrors acpMetaContext.
func AcpMetaContext(meta any) Ev {
	m := util.AsObj(meta)
	in := Num(m.Get("inputTokens"))
	o := Num(m.Get("outputTokens"))
	if in != nil {
		t := *in
		if o != nil {
			t += *o
		}
		return O("contextTokens", t)
	}
	return O()
}

// AgentEndStatus mirrors AGENT_END_STATUS.
var AgentEndStatus = map[string]string{
	"completed": "completed", "failed": "failed", "error": "failed", "errored": "failed",
	"stopped": "stopped", "killed": "stopped", "cancelled": "stopped", "shutdown": "stopped", "closed": "stopped",
}

// AgentUsage mirrors agentUsage.
func AgentUsage(u any) Ev {
	o, ok := u.(*util.Obj)
	if !ok {
		return nil
	}
	out := util.NewObj()
	if util.IsNum(o.Get("tool_uses")) {
		out.Set("toolUses", o.Get("tool_uses"))
	}
	if util.IsNum(o.Get("total_tokens")) {
		out.Set("tokens", o.Get("total_tokens"))
	}
	if util.IsNum(o.Get("duration_ms")) {
		out.Set("durationMs", o.Get("duration_ms"))
	}
	if out.Len() == 0 {
		return nil
	}
	return out
}
