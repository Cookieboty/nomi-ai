package quality

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ModelVendor 厂商：显示名 + 品牌图标 id
type ModelVendor struct{ Name, Brand string }

var vendors = []struct {
	re *regexp.Regexp
	v  ModelVendor
}{
	{regexp.MustCompile(`^(gpt|chatgpt|o\d|codex|davinci|text-embedding)`), ModelVendor{"OpenAI", "openai"}},
	{regexp.MustCompile(`^claude`), ModelVendor{"Anthropic", "anthropic"}},
	{regexp.MustCompile(`^(gemini|gemma)`), ModelVendor{"Google", "gemini"}},
	{regexp.MustCompile(`^deepseek`), ModelVendor{"DeepSeek", "deepseek"}},
	{regexp.MustCompile(`^(glm|chatglm|codegeex)`), ModelVendor{"Z.ai", "zhipu"}},
	{regexp.MustCompile(`^grok`), ModelVendor{"xAI", "xai"}},
	{regexp.MustCompile(`^(kimi|moonshot)`), ModelVendor{"Moonshot", "kimi"}},
	{regexp.MustCompile(`^(qwen|qwq|qvq)`), ModelVendor{"Qwen", "qwen"}},
	{regexp.MustCompile(`^(minimax|abab)`), ModelVendor{"MiniMax", "minimax"}},
	{regexp.MustCompile(`^doubao`), ModelVendor{"ByteDance", "doubao"}},
	{regexp.MustCompile(`^(llama|meta-llama)`), ModelVendor{Name: "Meta"}},
	{regexp.MustCompile(`^(mistral|mixtral|codestral|magistral|devstral)`), ModelVendor{Name: "Mistral"}},
	{regexp.MustCompile(`^ernie`), ModelVendor{Name: "Baidu"}},
	{regexp.MustCompile(`^hunyuan`), ModelVendor{Name: "Tencent"}},
}

// VendorOf = vendorOf
func VendorOf(family string) (ModelVendor, bool) {
	if family == "" {
		return ModelVendor{}, false
	}
	f := u.JSLower(family)
	for _, x := range vendors {
		if x.re.MatchString(f) {
			return x.v, true
		}
	}
	return ModelVendor{}, false
}

var upperWords = map[string]bool{"gpt": true, "glm": true, "llm": true, "vl": true, "tts": true, "asr": true, "ocr": true, "r1": true, "v3": true, "mini": true}
var brandWords = map[string]string{"deepseek": "DeepSeek", "chatgpt": "ChatGPT", "minimax": "MiniMax", "qwq": "QwQ", "qvq": "QVQ", "mini": "mini"}

var (
	reV     = regexp.MustCompile(`^v\d`)
	reDigit = regexp.MustCompile(`^\d`)
	reO     = regexp.MustCompile(`^o\d`)
)

func word(w string) string {
	if s, ok := brandWords[w]; ok && s != "" {
		return s
	}
	if upperWords[w] {
		return strings.ToUpper(w)
	}
	if reV.MatchString(w) {
		return "V" + w[1:]
	}
	if reDigit.MatchString(w) || reO.MatchString(w) {
		return w
	}
	rs := []rune(w)
	return strings.ToUpper(string(rs[0])) + string(rs[1:])
}

// splitParts = s.split(/[-_\s]+/).filter(Boolean)
func splitParts(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return r == '-' || r == '_' || u.IsJSWS(r) })
}

// PrettyModel = prettyModel
func PrettyModel(family string) (string, bool) {
	if family == "" {
		return "", false
	}
	parts := splitParts(u.JSLower(family))
	if len(parts) == 0 {
		return "", false
	}
	out := []string{}
	for i := 0; i < len(parts); i++ {
		w := parts[i]
		if (w == "gpt" || w == "glm") && i+1 < len(parts) && reDigit.MatchString(parts[i+1]) {
			out = append(out, word(w)+"-"+parts[i+1])
			i++
			continue
		}
		out = append(out, word(w))
	}
	return strings.Join(out, " "), true
}

var official = map[string]string{"anthropic": "Anthropic", "openai": "OpenAI", "xai": "xAI", "google": "Google", "deepseek": "DeepSeek"}

// OfficialProviderName = officialProviderName
func OfficialProviderName(id string) (string, bool) {
	s, ok := official[id]
	return s, ok
}
