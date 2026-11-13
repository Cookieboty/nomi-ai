// Package modelid compares the model a client asked for with the model name
// an upstream provider put on its response. Trivial aliases (case, a provider
// prefix, a date or "latest" suffix) are the same model.
package modelid

import (
	"context"
	"regexp"
	"strings"
	"unicode/utf8"
)

type turnCtxKey struct{}

// WithTurn returns a context the HTTP client reads to set TurnHeader.
func WithTurn(ctx context.Context, id string) context.Context {
	if ctx == nil || !ValidID(id) {
		return ctx
	}
	return context.WithValue(ctx, turnCtxKey{}, id)
}

// TurnFrom reads the turn id set by WithTurn.
func TurnFrom(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(turnCtxKey{}).(string)
	return TurnOf(id)
}

// TurnHeader is the request header Nomi's own chat sets so a gateway response
// can be matched back to that turn. Coding-assistant turns are matched by tab.
const TurnHeader = "x-nomi-turn"

var (
	slugRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	geminiPath = regexp.MustCompile(`^(?:projects/[^/]+/locations/[^/]+/)?(?:publishers/[^/]+/)?models/`)
	reLatest   = regexp.MustCompile(`(?:-latest|:latest|@latest)$`)
	reDate8    = regexp.MustCompile(`-\d{8}$`)
	reDateISO  = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)
	reAtDate   = regexp.MustCompile(`[@:]\d{8}$`)
	reDotVer   = regexp.MustCompile(`(\d)\.(\d)`)
)

// ValidID reports whether s can be used as a turn key (header / map key).
func ValidID(s string) bool {
	if s == "" || len(s) > 80 {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

// TurnOf returns a usable turn id from a header value, or "".
func TurnOf(s string) string {
	s = strings.TrimSpace(s)
	if !ValidID(s) {
		return ""
	}
	return s
}

func TurnKey(id string) string { return "turn:" + id }
func TabKey(id string) string  { return "tab:" + id }

// Clip trims s and keeps at most n bytes on a UTF-8 boundary.
func Clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if n <= 0 || len(s) <= n {
		return s
	}
	i := 0
	for i < len(s) {
		_, size := utf8.DecodeRuneInString(s[i:])
		if size <= 0 || i+size > n {
			break
		}
		i += size
	}
	return s[:i]
}

// Canonical is the form used to decide whether two names are the same model.
func Canonical(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "_", "-")
	s = geminiPath.ReplaceAllString(s, "")
	if strings.Count(s, "/") == 1 {
		left, right, _ := strings.Cut(s, "/")
		if left != "" && right != "" && slugRe.MatchString(left) {
			s = right
		}
	}
	s = reDotVer.ReplaceAllString(s, "${1}-${2}")
	for {
		next := stripAlias(s)
		if next == s || next == "" {
			break
		}
		s = next
	}
	return s
}

func stripAlias(s string) string {
	for _, re := range []*regexp.Regexp{reLatest, reDateISO, reDate8, reAtDate} {
		if loc := re.FindStringIndex(s); loc != nil && loc[0] > 0 {
			return s[:loc[0]]
		}
	}
	return s
}

// Mismatch returns the raw returned name when it is a different model from
// every non-empty requested name. Aliases return "". Nothing to compare
// against (no requested name, or an empty return) also returns "".
func Mismatch(requested []string, returned string) string {
	raw := strings.TrimSpace(returned)
	if raw == "" {
		return ""
	}
	got := Canonical(raw)
	if got == "" {
		return ""
	}
	saw := false
	for _, r := range requested {
		c := Canonical(r)
		if c == "" {
			continue
		}
		saw = true
		if c == got {
			return ""
		}
	}
	if !saw {
		return ""
	}
	return Clip(raw, 200)
}
