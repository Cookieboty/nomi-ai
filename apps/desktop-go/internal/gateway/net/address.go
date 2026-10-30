// Package net mirrors apps/desktop-electron/internal/gateway/src/net/*: address classification,
// loopback Host checks, the upstream guard and the pinned-IP upstream fetch.
package net

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	hexPart = regexp.MustCompile(`(?i)^0x[0-9a-f]*$`)
	octPart = regexp.MustCompile(`^0[0-7]+$`)
	decPart = regexp.MustCompile(`^(0|[1-9]\d*)$`)
	v4Tail  = regexp.MustCompile(`(\d+\.\d+\.\d+\.\d+)$`)
	v6Group = regexp.MustCompile(`(?i)^[0-9a-f]{1,4}$`)
)

func parseNum(s string, base int) float64 {
	if s == "" {
		return 0
	}
	n, err := strconv.ParseUint(s, base, 64)
	if err != nil {
		f, _ := strconv.ParseFloat(s, 64) // overflow: JS parseInt gives a huge finite number
		if base != 10 {
			return math.Inf(1)
		}
		return f
	}
	return float64(n)
}

// ParseIPv4 is parseIPv4 (inet_aton-style lenient parse); nil = not IPv4.
func ParseIPv4(host string) []int {
	parts := strings.Split(host, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return nil
	}
	nums := []float64{}
	for _, p := range parts {
		if p == "" {
			return nil
		}
		var n float64
		switch {
		case hexPart.MatchString(p):
			if len(p) == 2 {
				n = 0
			} else {
				n = parseNum(p[2:], 16)
			}
		case octPart.MatchString(p):
			n = parseNum(p, 8)
		case decPart.MatchString(p):
			n = parseNum(p, 10)
		default:
			return nil
		}
		if math.IsInf(n, 0) || math.IsNaN(n) {
			return nil
		}
		nums = append(nums, n)
	}
	last := nums[len(nums)-1]
	nums = nums[:len(nums)-1]
	for _, n := range nums {
		if n > 255 {
			return nil
		}
	}
	rest := 4 - len(nums)
	if last >= math.Pow(2, float64(8*rest)) {
		return nil
	}
	out := make([]int, 0, 4)
	for _, n := range nums {
		out = append(out, int(n))
	}
	for i := rest - 1; i >= 0; i-- {
		out = append(out, int(math.Mod(math.Floor(last/math.Pow(2, float64(8*i))), 256)))
	}
	return out
}

func isPrivateV4(b []int) bool {
	a, x, c := b[0], b[1], b[2]
	return a == 0 || a == 10 || a == 127 ||
		(a == 100 && x >= 64 && x <= 127) ||
		(a == 169 && x == 254) ||
		(a == 172 && x >= 16 && x <= 31) ||
		(a == 192 && x == 0 && c == 0) ||
		(a == 192 && x == 168) ||
		(a == 198 && (x == 18 || x == 19)) ||
		a >= 224
}

// ParseIPv6 is parseIPv6: 8 16-bit groups, nil when invalid.
func ParseIPv6(host string) []int {
	h := strings.Split(host, "%")[0]
	if !strings.Contains(h, ":") {
		return nil
	}
	if m := v4Tail.FindStringSubmatch(h); m != nil {
		b := ParseIPv4(m[1])
		if b == nil || len(strings.Split(m[1], ".")) != 4 {
			return nil
		}
		h = h[:len(h)-len(m[1])] + strconv.FormatInt(int64(b[0]<<8|b[1]), 16) + ":" + strconv.FormatInt(int64(b[2]<<8|b[3]), 16)
	}
	halves := strings.Split(h, "::")
	if len(halves) > 2 {
		return nil
	}
	seg := func(s string) []string {
		if s == "" {
			return nil
		}
		return strings.Split(s, ":")
	}
	head := seg(halves[0])
	var tail []string
	if len(halves) == 2 {
		tail = seg(halves[1])
	}
	fill := 8 - len(head) - len(tail)
	if len(halves) == 1 {
		if len(head) != 8 {
			return nil
		}
	} else if fill < 1 {
		return nil
	}
	all := append([]string{}, head...)
	if len(halves) == 2 {
		for i := 0; i < fill; i++ {
			all = append(all, "0")
		}
	}
	all = append(all, tail...)
	out := make([]int, len(all))
	for i, g := range all {
		if !v6Group.MatchString(g) {
			return nil
		}
		n, _ := strconv.ParseInt(g, 16, 32)
		out[i] = int(n)
	}
	return out
}

func isPrivateV6(g []int) bool {
	zero := func(from, to int) bool {
		for _, x := range g[from:to] {
			if x != 0 {
				return false
			}
		}
		return true
	}
	emb := func() []int { return []int{g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255} }
	switch {
	case zero(0, 7) && (g[7] == 0 || g[7] == 1):
		return true
	case zero(0, 5) && g[5] == 0xffff:
		return isPrivateV4(emb())
	case zero(0, 6):
		return isPrivateV4(emb())
	case g[0] == 0x64 && g[1] == 0xff9b && zero(2, 6):
		return isPrivateV4(emb())
	case g[0]&0xfe00 == 0xfc00, g[0]&0xffc0 == 0xfe80, g[0]&0xff00 == 0xff00:
		return true
	}
	return false
}

func stripBrackets(h string) string {
	h = strings.TrimPrefix(h, "[")
	return strings.TrimSuffix(h, "]")
}

// IsPrivateHost is isPrivateHost.
func IsPrivateHost(hostname string) bool {
	h := strings.TrimSuffix(stripBrackets(strings.ToLower(hostname)), ".")
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") {
		return true
	}
	if v6 := ParseIPv6(h); v6 != nil {
		return isPrivateV6(v6)
	}
	if v4 := ParseIPv4(h); v4 != nil {
		return isPrivateV4(v4)
	}
	return false
}
