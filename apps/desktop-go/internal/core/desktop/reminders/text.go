package reminders

import (
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func trimJS2(s string) string { return strings.TrimFunc(s, isJSSpace) }

// clip：JS slice(0, n)（UTF-16）
func Clip(s string, n int) string { return clip(s, n) }

// TrimJS：String.prototype.trim
func TrimJS(s string) string { return trimJS2(s) }

func clip(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

var (
	reISO   = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$`)
	reLoose = regexp.MustCompile(`^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(Z|[+-]\d{2}:?\d{2}|GMT[+-]\d{4}|UTC)?$`)
)

// DateParse：Date.parse 的常见格式（D-B6-9）：ISO 8601（仅日期按 UTC，日期时间无时区按本地）、
// "YYYY-MM-DD HH:mm[:ss]" / "YYYY/MM/DD HH:mm" 本地时间、RFC 1123 / RFC 3339
func DateParse(s string) (float64, bool) {
	s = trimJS2(s)
	if m := reISO.FindStringSubmatch(s); m != nil {
		y, _ := strconv.Atoi(m[1])
		mo, d := 1, 1
		if m[2] != "" {
			mo, _ = strconv.Atoi(m[2])
		}
		if m[3] != "" {
			d, _ = strconv.Atoi(m[3])
		}
		loc := time.UTC
		if m[4] != "" && m[8] == "" {
			loc = time.Local
		}
		hh, mi, ss, ns := atoi(m[4]), atoi(m[5]), atoi(m[6]), 0
		if m[7] != "" {
			frac := (m[7] + "000000000")[:9]
			ns, _ = strconv.Atoi(frac)
			ns = ns / 1e6 * 1e6
		}
		if mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || hh > 24 || mi > 59 || ss > 59 || (hh == 24 && (mi|ss|ns) != 0) {
			return 0, false
		}
		if m[8] != "" && m[8] != "Z" {
			sign := 1
			if m[8][0] == '-' {
				sign = -1
			}
			oh, om := atoi(m[8][1:3]), atoi(m[8][4:6])
			loc = time.FixedZone("", sign*(oh*3600+om*60))
		}
		return float64(time.Date(y, time.Month(mo), d, hh, mi, ss, ns, loc).UnixMilli()), true
	}
	if m := reLoose.FindStringSubmatch(s); m != nil {
		y, mo, d := atoi(m[1]), atoi(m[2]), atoi(m[3])
		hh, mi, ss, ms := atoi(m[4]), atoi(m[5]), atoi(m[6]), 0
		if m[7] != "" {
			ms, _ = strconv.Atoi((m[7] + "00")[:3])
		}
		if mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 24 || mi > 59 || ss > 59 {
			return 0, false
		}
		loc := time.Local
		switch z := m[8]; {
		case z == "Z" || z == "UTC":
			loc = time.UTC
		case z != "":
			z = strings.TrimPrefix(z, "GMT")
			z = strings.ReplaceAll(z, ":", "")
			sign := 1
			if z[0] == '-' {
				sign = -1
			}
			loc = time.FixedZone("", sign*(atoi(z[1:3])*3600+atoi(z[3:5])*60))
		}
		return float64(time.Date(y, time.Month(mo), d, hh, mi, ss, ms*1e6, loc).UnixMilli()), true
	}
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, "Mon, 2 Jan 2006 15:04:05 MST", "Mon Jan 2 2006 15:04:05 GMT-0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			return float64(t.UnixMilli()), true
		}
	}
	return 0, false
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func daysIn(y, m int) int { return time.Date(y, time.Month(m+1), 0, 0, 0, 0, 0, time.UTC).Day() }
