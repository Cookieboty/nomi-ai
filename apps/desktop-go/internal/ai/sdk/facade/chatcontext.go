// Package facade = apps/desktop-electron/internal/ai-sdk/src/facade（ChatFacade + chatContext）
package facade

import (
	"unicode/utf16"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
)

// ContextBudget = chatContext.ts ContextBudget（nil 字段 = undefined）
type ContextBudget struct {
	MaxTokens   *float64 `json:"maxTokens,omitempty"`
	MaxMessages *float64 `json:"maxMessages,omitempty"`
}

const (
	defaultMaxTokens   = 8000
	defaultMaxMessages = 50
	messageOverhead    = 4
	truncationMark     = "…[truncated]"
)

func wide(c uint16) bool {
	return (c >= 0x3000 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) ||
		(c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)
}

func estimateUnits(s []uint16) float64 {
	if len(s) == 0 {
		return 0
	}
	w := 0
	for _, c := range s {
		if wide(c) {
			w++
		}
	}
	n := len(s) - w
	return float64(w + (n+3)/4)
}

// EstimateTokens = estimateTokens(text)（按 UTF-16 码元计，同 JS）
func EstimateTokens(text string) float64 { return estimateUnits(utf16.Encode([]rune(text))) }

// EstimateMessageTokens = estimateMessageTokens(m)
func EstimateMessageTokens(m blm.ChatMessage) float64 {
	return EstimateTokens(m.Content) + messageOverhead
}

func decode(s []uint16) string { return string(utf16.Decode(s)) }

func truncateToTokens(text string, tokens float64) string {
	if tokens <= 0 {
		return truncationMark
	}
	s := utf16.Encode([]rune(text))
	if estimateUnits(s) <= tokens {
		return text
	}
	lo, hi := 0, len(s)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if estimateUnits(s[:mid]) <= tokens {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return decode(s[:lo]) + truncationMark
}

// FitMessagesToBudget = fitMessagesToBudget(messages, budget)
func FitMessagesToBudget(messages []blm.ChatMessage, b *ContextBudget) []blm.ChatMessage {
	maxTokens := float64(defaultMaxTokens)
	maxMessages := float64(defaultMaxMessages)
	if b != nil && b.MaxTokens != nil {
		maxTokens = *b.MaxTokens
	}
	if b != nil && b.MaxMessages != nil {
		maxMessages = *b.MaxMessages
	}
	if maxMessages < 1 {
		maxMessages = 1
	}
	var system, rest []blm.ChatMessage
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m)
		} else {
			rest = append(rest, m)
		}
	}
	if len(rest) == 0 {
		return append([]blm.ChatMessage{}, system...)
	}
	used := 0.0
	for _, m := range system {
		used += EstimateMessageTokens(m)
	}
	last := rest[len(rest)-1]
	lastKept := last
	lastCost := EstimateMessageTokens(last)
	if used+lastCost > maxTokens {
		lastKept.Content = truncateToTokens(last.Content, maxTokens-used-messageOverhead)
		used += EstimateMessageTokens(lastKept)
	} else {
		used += lastCost
	}
	window := []blm.ChatMessage{lastKept}
	for i := len(rest) - 2; i >= 0 && float64(len(window)) < maxMessages; i-- {
		cost := EstimateMessageTokens(rest[i])
		if used+cost > maxTokens {
			break
		}
		used += cost
		window = append([]blm.ChatMessage{rest[i]}, window...)
	}
	for len(window) > 1 && window[0].Role != "user" {
		window = window[1:]
	}
	return append(append([]blm.ChatMessage{}, system...), window...)
}
