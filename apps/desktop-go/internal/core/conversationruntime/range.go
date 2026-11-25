package conversationruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

// ByteRange is a half-open range of UTF-8 byte offsets into the exact latest
// revision text (no normalization).
type ByteRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// TextDigest is the SHA-256 of the exact UTF-8 text (integrity, not security).
func TextDigest(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// UTF16Len counts UTF-16 code units (surrogate pairs count 2). It backs the
// legacy logical-text measure and the Windows argv check; it is never added to
// serialized UTF-8 byte counts.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

var ErrInvalidRange = errors.New("conversationruntime: invalid byte range")

// normalizeRanges checks byte bounds and returns the ranges
// sorted and merged (adjacent or overlapping ranges are fine).
func normalizeRanges(ranges []ByteRange, textLen int) ([]ByteRange, error) {
	if len(ranges) == 0 {
		return nil, nil
	}
	sorted := append([]ByteRange(nil), ranges...)
	for _, r := range sorted {
		if r.Start < 0 || r.Start >= r.End || r.End > textLen {
			return nil, fmt.Errorf("%w: [%d,%d) of %d", ErrInvalidRange, r.Start, r.End, textLen)
		}
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })
	out := sorted[:1]
	for _, r := range sorted[1:] {
		last := &out[len(out)-1]
		if r.Start <= last.End {
			if r.End > last.End {
				last.End = r.End
			}
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

// ValidateRanges checks byte bounds and rune boundaries. Overlap is allowed
// because acknowledgements are merged as a union.
func ValidateRanges(ranges []ByteRange, text string) error {
	if !utf8.ValidString(text) {
		return fmt.Errorf("%w: text is not valid UTF-8", ErrInvalidRange)
	}
	for _, r := range ranges {
		if r.Start < 0 || r.Start >= r.End || r.End > len(text) {
			return fmt.Errorf("%w: [%d,%d) of %d", ErrInvalidRange, r.Start, r.End, len(text))
		}
		if !utf8.RuneStart(text[r.Start]) || (r.End < len(text) && !utf8.RuneStart(text[r.End])) {
			return fmt.Errorf("%w: [%d,%d) splits a rune", ErrInvalidRange, r.Start, r.End)
		}
	}
	if _, err := normalizeRanges(ranges, len(text)); err != nil {
		return err
	}
	return nil
}

func utf8OK(s string) bool { return utf8.ValidString(s) }
