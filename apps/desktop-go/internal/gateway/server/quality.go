package server

import (
	"regexp"
	"strconv"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// QualityTiming is QualityTiming (nil = undefined).
type QualityTiming struct {
	HeadersMs      *float64 `json:"headersMs,omitempty"`
	FirstContentMs *float64 `json:"firstContentMs,omitempty"`
	FirstTextMs    *float64 `json:"firstTextMs,omitempty"`
	LastContentMs  *float64 `json:"lastContentMs,omitempty"`
	EndMs          float64  `json:"endMs"`
}

// QualityAttempt is QualityAttempt.
type QualityAttempt struct {
	Provider     string   `json:"provider"`
	KeyID        *string  `json:"keyId,omitempty"`
	Model        string   `json:"model"`
	UpstreamWire *string  `json:"upstreamWire,omitempty"`
	Status       *int     `json:"status,omitempty"`
	Outcome      string   `json:"outcome"`
	Ms           float64  `json:"ms"`
	HeadersMs    *float64 `json:"headersMs,omitempty"`
	ErrorKind    *string  `json:"errorKind,omitempty"`
}

const (
	BurstMaxGenMs        = 100
	BurstMinOutputTokens = 20
)

// IsBurst is isBurst.
func IsBurst(first, last, outputTokens *float64) bool {
	if first == nil || last == nil {
		return false
	}
	o := 0.0
	if outputTokens != nil {
		o = *outputTokens
	}
	return *last-*first < BurstMaxGenMs && o >= BurstMinOutputTokens
}

var rejectedText = regexp.MustCompile(`(?i)context(?:[ _-]?length| window)|too many tokens|maximum context|prompt is too long|request too large|payload too large`)

// Classified is {outcome, errorKind?}.
type Classified struct {
	Outcome   string
	ErrorKind *string
}

func cls(o string, k ...string) Classified {
	if len(k) > 0 {
		return Classified{o, &k[0]}
	}
	return Classified{Outcome: o}
}

// AttemptFailure is the classifyAttemptFailure argument.
type AttemptFailure struct {
	Status         int
	UpstreamStatus *int
	Network        bool
	Text, Message  *string
}

// ClassifyAttemptFailure is classifyAttemptFailure.
func ClassifyAttemptFailure(f AttemptFailure) Classified {
	text := ""
	if f.Text != nil {
		text = *f.Text
	}
	text += " "
	if f.Message != nil {
		text += *f.Message
	}
	if f.UpstreamStatus != nil {
		s := *f.UpstreamStatus
		switch {
		case s == 401 || s == 403:
			return cls("auth", strconv.Itoa(s))
		case s == 429:
			return cls("rate-limit", "429")
		case s >= 500:
			return cls("upstream-5xx", strconv.Itoa(s))
		case s >= 300 && s < 400:
			return cls("upstream-5xx", "redirect")
		}
		if rejectedText.MatchString(u.JSIText(text)) {
			return cls("request-rejected", "context-length")
		}
		return cls("request-rejected", strconv.Itoa(s))
	}
	switch {
	case f.Network:
		return cls("upstream-5xx", "connect")
	case f.Status == 504:
		return cls("first-byte-timeout")
	case f.Status == 429:
		return cls("rate-limit", "local-limit")
	case f.Status == 400:
		return cls("request-rejected", "local-check")
	}
	return cls("gateway-error")
}

// ClassifyPreCommit is classifyPreCommit.
func ClassifyPreCommit(status int, upstreamStatus *int) Classified {
	s := status
	if upstreamStatus != nil {
		s = *upstreamStatus
	}
	switch s {
	case 429:
		return cls("rate-limit", "event")
	case 529:
		return cls("upstream-5xx", "overloaded")
	}
	return cls("pre-commit-error")
}

var (
	invalidToolRe = regexp.MustCompile(`(?i)invalid tool call`)
	blockedRe     = regexp.MustCompile(`(?i)(response|prompt) blocked`)
	noTerminalRe  = regexp.MustCompile(`(?i)ended (before completion|without any data)`)
)

// ClassifyStreamError is classifyStreamError.
func ClassifyStreamError(message, errorType string) Classified {
	m := u.JSIText(message)
	switch {
	case invalidToolRe.MatchString(m):
		return cls("protocol-violation", "invalid-tool-call")
	case blockedRe.MatchString(m):
		return cls("request-rejected", "blocked")
	case noTerminalRe.MatchString(m):
		return cls("stream-break", "no-terminal")
	}
	if errorType == "" {
		errorType = "upstream-error"
	}
	return cls("stream-break", errorType)
}
