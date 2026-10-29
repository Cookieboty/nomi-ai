// Package cli ports packages/core/src/cli（batch 7）。
package cli

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	semverRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)
	preRe    = regexp.MustCompile(`\d+\.\d+\.\d+-([0-9A-Za-z.-]+)`)
	digitsRe = regexp.MustCompile(`^\d+$`)
)

func jsNum(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}

// ParseSemver = parseSemver（nil = null）。
func ParseSemver(raw string) []float64 {
	m := semverRe.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	return []float64{jsNum(m[1]), jsNum(m[2]), jsNum(m[3])}
}

func prerelease(raw string) []string {
	m := preRe.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	return strings.Split(m[1], ".")
}

func comparePre(a, b []string) int {
	if a == nil && b == nil {
		return 0
	}
	if a == nil {
		return 1
	}
	if b == nil {
		return -1
	}
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if i >= len(a) {
			return -1
		}
		if i >= len(b) {
			return 1
		}
		x, y := a[i], b[i]
		nx, ny := digitsRe.MatchString(x), digitsRe.MatchString(y)
		if nx && ny {
			if jsNum(x) != jsNum(y) {
				if jsNum(x) > jsNum(y) {
					return 1
				}
				return -1
			}
		} else if nx != ny {
			if nx {
				return -1
			}
			return 1
		} else if x != y {
			if utf16Less(y, x) {
				return 1
			}
			return -1
		}
	}
	return 0
}

// utf16Less：JS 字符串比较按 UTF-16 码元（此处只含 ASCII，与字节序一致）。
func utf16Less(a, b string) bool { return a < b }

// IsNewer = isNewer。
func IsNewer(latest, current string) bool {
	a, b := ParseSemver(latest), ParseSemver(current)
	if a == nil || b == nil {
		return false
	}
	for i := 0; i < 3; i++ {
		if a[i] > b[i] {
			return true
		}
		if a[i] < b[i] {
			return false
		}
	}
	return comparePre(prerelease(latest), prerelease(current)) > 0
}
