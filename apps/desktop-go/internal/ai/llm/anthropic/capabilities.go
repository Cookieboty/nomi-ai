package anthropic

import "strings"

// capabilities is getModelCapabilities' result.
type capabilities struct {
	maxOutputTokens                        float64
	supportsStructuredOutput               bool
	supportsAdaptiveThinking               bool
	rejectsSamplingParameters              bool
	supportsXhighEffort                    bool
	rejectsThinkingDisabledAboveHighEffort bool
	rejectsThinkingDisabled                bool
	rejectsBudgetThinking                  bool
	rejectsForcedToolUse                   bool
	supportsBetweenToolsThinking           bool
	isKnownModel                           bool
}

// getModelCapabilities mirrors anthropic-language-model.ts getModelCapabilities
// (first match on substring; regex arms hand-written since Go RE2 has no lookahead).
func getModelCapabilities(id string) capabilities {
	has := func(s string) bool { return strings.Contains(id, s) }
	switch {
	case has("claude-sonnet-5-5"):
		return capabilities{128000, true, true, true, true, true, true, true, true, true, true}
	case has("claude-opus-5-5"):
		return capabilities{128000, true, true, true, true, true, true, true, true, false, true}
	case has("claude-haiku-5-5"):
		return capabilities{128000, true, true, true, true, true, false, true, false, false, true}
	case has("claude-opus-5"):
		return capabilities{128000, true, true, true, true, true, false, false, false, false, true}
	case has("claude-fable-5-1"):
		return capabilities{128000, true, true, true, true, false, true, true, true, false, true}
	case has("claude-fable-5"):
		return capabilities{128000, true, true, true, true, false, true, true, false, false, true}
	case has("claude-opus-4-8") || has("claude-opus-4-7") || has("claude-sonnet-5"):
		return capabilities{128000, true, true, true, true, false, false, false, false, false, true}
	case has("claude-sonnet-4-6") || has("claude-opus-4-6"):
		return capabilities{128000, true, true, false, false, false, false, false, false, false, true}
	case has("claude-sonnet-4-5") || has("claude-opus-4-5") || has("claude-haiku-4-5"):
		return capabilities{64000, true, false, false, false, false, false, false, false, false, true}
	case has("claude-opus-4-1"):
		return capabilities{32000, true, false, false, false, false, false, false, false, false, true}
	case has("claude-sonnet-4-") || has("claude-sonnet-4@"):
		return capabilities{64000, false, false, false, false, false, false, false, false, false, true}
	case has("claude-opus-4-") || has("claude-opus-4@"):
		return capabilities{32000, false, false, false, false, false, false, false, false, false, true}
	case has("claude-3-haiku"):
		return capabilities{4096, false, false, false, false, false, false, false, false, false, true}
	case isLegacyClaude(id):
		return capabilities{4096, false, false, false, false, false, false, false, false, false, false}
	case has("claude-"):
		return capabilities{128000, true, true, true, true, true, false, false, false, false, false}
	}
	return capabilities{maxOutputTokens: 4096}
}

// isLegacyClaude is /claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/.
func isLegacyClaude(id string) bool {
	for i := 0; ; {
		j := strings.Index(id[i:], "claude-")
		if j < 0 {
			return false
		}
		rest := id[i+j+7:]
		if strings.HasPrefix(rest, "instant") {
			r := rest[7:]
			if r == "" || r[0] == '-' {
				return true
			}
		}
		r := rest
		if strings.HasPrefix(r, "v") {
			r = r[1:]
		}
		if strings.HasPrefix(r, "2") && (len(r) == 1 || strings.ContainsRune("-.:", rune(r[1]))) {
			return true
		}
		if strings.HasPrefix(rest, "3") && (len(rest) == 1 || strings.ContainsRune("-.", rune(rest[1]))) {
			return true
		}
		i += j + 1
	}
}
