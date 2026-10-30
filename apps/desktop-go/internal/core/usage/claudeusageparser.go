package usage

// 对应 apps/desktop-electron/internal/core/src/usage/claudeUsageParser.ts：解析 `claude -p /usage --output-format json`。
// 注：JS 正则的 /i 只做 ASCII 等价折叠（ſ / K 不等于 s / k），这里用显式字符类而非 RE2 (?i)。

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const cupHourMS = 3_600_000

var cupMonths = strings.Split("jan feb mar apr may jun jul aug sep oct nov dec", " ")

var cupDeniedHints = []string{
	"unauthorized", "forbidden", "signed out", "not signed in", "not logged in", "please run /login",
	"sign-in expired", "sign-in has expired", "authentication failed", "authentication required",
	"invalid token", "invalid access token", "invalid api key",
}

var cupUnsupportedHints = []string{
	"unknown skill", "unknown command", "unknown slash command", "isn't available in this environment",
	"is not available in this environment", "not available in non-interactive",
}

var (
	cupAnsiRe    = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	cupDenyRe    = regexp.MustCompile(`\b(?:401|403)\b`)
	cupClockRe   = regexp.MustCompile(`([0-9]{1,2})(?::([0-9]{2}))?[` + util.JSWS + `]*([Aa][Mm]|[Pp][Mm])$`)
	cupDateTail  = regexp.MustCompile(`(?:[` + util.JSWS + `]+at|,)[` + util.JSWS + `]*$`)
	cupDateRe    = regexp.MustCompile(`^([A-Za-z0-9_]{3})[A-Za-z0-9_]*[` + util.JSWS + `]+([0-9]{1,2})(?:,[` + util.JSWS + `]*([0-9]{4}))?$`)
	cupPctRe     = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)%(?:[` + util.JSWS + `]+[Uu][Ss][Ee][Dd])?$`)
	cupResetsRe  = regexp.MustCompile(`^[Rr][Ee][Ss][Ee][Tt][Ss][` + util.JSWS + `]`)
	cupResetsPfx = regexp.MustCompile(`^[Rr][Ee][Ss][Ee][Tt][Ss][` + util.JSWS + `]+`)
)

func cupStripAnsi(s string) string { return cupAnsiRe.ReplaceAllString(s, "") }

func cupDenied(text string) bool {
	lower := util.JSLower(text)
	if cupDenyRe.MatchString(lower) {
		return true
	}
	for _, h := range cupDeniedHints {
		if strings.Contains(lower, h) {
			return true
		}
	}
	return false
}

// cupFormatter：Intl.DateTimeFormat 的时区；不认识返回 nil
func cupFormatter(zone string) *time.Location {
	if zone == "" || zone == "Local" {
		return nil
	}
	// Intl 的时区名大小写不敏感；IANA 文件名区分大小写 → 先原样，再按名单不区分大小写匹配
	if loc, err := time.LoadLocation(zone); err == nil {
		return loc
	}
	cupTZOnce.Do(func() {
		cupTZLower = map[string]string{}
		for _, n := range tzNames {
			cupTZLower[strings.ToLower(n)] = n
		}
	})
	if n, ok := cupTZLower[strings.ToLower(zone)]; ok {
		if loc, err := time.LoadLocation(n); err == nil {
			return loc
		}
	}
	return nil
}

var (
	cupTZOnce  sync.Once
	cupTZLower map[string]string
)

// dateUTC = Date.UTC（年份 0..99 → 19xx；月日溢出自动进位）
func dateUTC(y, mo, d, h, mi, s int) float64 {
	if y >= 0 && y <= 99 {
		y += 1900
	}
	return float64(time.Date(y, time.Month(mo+1), d, h, mi, s, 0, time.UTC).UnixMilli())
}

func cupWall(loc *time.Location, instant float64) float64 {
	t := time.UnixMilli(int64(math.Floor(instant))).In(loc)
	return dateUTC(t.Year(), int(t.Month())-1, t.Day(), t.Hour(), t.Minute(), t.Second())
}

func cupResolve(loc *time.Location, clock float64) []float64 {
	var found []float64
	seen := map[float64]bool{}
	for h := -36; h <= 36; h += 6 {
		probe := clock + float64(float64(h)*cupHourMS)
		offset := cupWall(loc, probe) - probe
		instant := clock - offset
		if cupWall(loc, instant) == clock && !seen[instant] {
			seen[instant] = true
			found = append(found, instant)
		}
	}
	return found
}

// ParseClaudeResetTime：「3pm (Asia/Shanghai)」等 → ms；nil = 取不到
func ParseClaudeResetTime(input string, now float64, spanHours float64) *float64 {
	if math.IsNaN(now) || math.IsInf(now, 0) {
		return nil
	}
	text := util.JSTrim(input)
	loc := time.Local
	if zs := strings.LastIndex(text, "("); zs >= 0 && strings.HasSuffix(text, ")") {
		inner := ""
		if zs+1 <= len(text)-1 {
			inner = text[zs+1 : len(text)-1]
		}
		if l := cupFormatter(inner); l != nil {
			loc = l
		}
		text = util.JSTrim(text[:zs])
	}
	m := cupClockRe.FindStringSubmatchIndex(text)
	if m == nil {
		return nil
	}
	hour, _ := strconv.Atoi(text[m[2]:m[3]])
	minute := 0
	if m[4] >= 0 {
		minute, _ = strconv.Atoi(text[m[4]:m[5]])
	}
	if hour < 1 || hour > 12 || minute > 59 {
		return nil
	}
	h24 := hour % 12
	if strings.ToLower(text[m[6]:m[7]]) == "pm" {
		h24 += 12
	}
	dateText := util.JSTrim(cupDateTail.ReplaceAllString(text[:m[0]], ""))
	today := time.UnixMilli(int64(cupWall(loc, now))).UTC()
	var cands []float64
	explicitYear := false
	if dateText != "" {
		dm := cupDateRe.FindStringSubmatch(dateText)
		if dm == nil {
			return nil
		}
		month := -1
		for i, mo := range cupMonths {
			if mo == strings.ToLower(dm[1]) {
				month = i
			}
		}
		day, _ := strconv.Atoi(dm[2])
		if month < 0 || day < 1 {
			return nil
		}
		explicitYear = dm[3] != ""
		y := today.Year()
		years := []int{y - 1, y, y + 1}
		if explicitYear {
			yy, _ := strconv.Atoi(dm[3])
			years = []int{yy}
		}
		for _, yy := range years {
			stamp := dateUTC(yy, month, day, h24, minute, 0)
			d := time.UnixMilli(int64(stamp)).UTC()
			if int(d.Month())-1 == month && d.Day() == day {
				cands = append(cands, cupResolve(loc, stamp)...)
			}
		}
	} else {
		for off := -2; off <= 2; off++ {
			cands = append(cands, cupResolve(loc, dateUTC(today.Year(), int(today.Month())-1, today.Day()+off, h24, minute, 0))...)
		}
	}
	sort.Float64s(cands)
	horizon := now + float64((spanHours+2)*cupHourMS)
	var chosen *float64
	if explicitYear {
		if len(cands) > 0 {
			chosen = f64p(cands[0])
		}
	} else {
		for _, x := range cands {
			if x >= now && x <= horizon {
				chosen = f64p(x)
				break
			}
		}
		if chosen == nil && dateText != "" {
			for _, x := range cands {
				if x >= now-float64(24*cupHourMS) && x <= horizon {
					chosen = f64p(x)
					break
				}
			}
		}
		if chosen == nil && dateText == "" {
			for _, x := range cands {
				if x < now {
					chosen = f64p(x)
				}
			}
		}
	}
	return chosen
}

type ParsedClaudeUsage struct {
	Windows     []QuotaWindow `json:"windows"`
	Denied      bool          `json:"denied"`
	IsError     bool          `json:"isError"`
	Unsupported bool          `json:"unsupported"`
}

func ParseClaudeUsageResult(output string, now float64) ParsedClaudeUsage {
	bad := ParsedClaudeUsage{Windows: []QuotaWindow{}, IsError: true}
	decoded, err := util.ParseString(output)
	if err != nil {
		bad.Denied = cupDenied(cupStripAnsi(output))
		return bad
	}
	if arr, ok := decoded.([]any); ok {
		decoded = nil
		for _, x := range arr {
			if o, ok := x.(*util.Obj); ok {
				if s, ok := o.Get("type").(string); ok && s == "result" {
					decoded = o
				}
			}
		}
	}
	env, ok := decoded.(*util.Obj)
	if !ok {
		return bad
	}
	res, ok := env.Get("result").(string)
	if !ok {
		return bad
	}
	text := cupStripAnsi(res)
	lower := util.JSLower(text)
	lc, _ := env.Get("local_command").(string)
	nt, ntOK := env.Get("num_turns").(float64)
	unsupported := (env.Get("local_command") == nil || lc != "usage") && ntOK && nt > 0
	if _, isStr := env.Get("local_command").(string); isStr && lc == "usage" {
		unsupported = false
	}
	for _, h := range cupUnsupportedHints {
		if strings.Contains(lower, h) {
			unsupported = true
		}
	}
	denied := !unsupported && cupDenied(text)
	wins := map[string]QuotaWindow{}
	if !denied && !unsupported {
		for _, line := range strings.Split(text, "\n") {
			sep := strings.Index(line, ":")
			if sep < 0 {
				continue
			}
			label := util.JSLower(util.JSTrim(line[:sep]))
			session := label == "current session"
			if !session && label != "current week (all models)" && label != "current week" {
				continue
			}
			parts := strings.Split(line[sep+1:], "·")
			for i := range parts {
				parts[i] = util.JSTrim(parts[i])
			}
			pm := cupPctRe.FindStringSubmatch(parts[0])
			if pm == nil {
				continue
			}
			v, err := strconv.ParseFloat(pm[1], 64)
			if err != nil || math.IsInf(v, 0) {
				continue
			}
			id, span, wm := "seven_day", 168.0, 10080.0
			if session {
				id, span, wm = "five_hour", 5, 300
			}
			if _, has := wins[id]; has {
				continue
			}
			var resetAt *float64
			for _, x := range parts {
				if cupResetsRe.MatchString(x) {
					resetAt = ParseClaudeResetTime(cupResetsPfx.ReplaceAllString(x, ""), now, span)
					break
				}
			}
			w := QuotaWindow{ID: id, UsedPercent: math.Max(0, math.Min(100, v)), WindowMinutes: f64p(wm)}
			if resetAt != nil && *resetAt != 0 {
				w.ResetAt = resetAt
			}
			wins[id] = w
		}
	}
	out := ParsedClaudeUsage{Windows: []QuotaWindow{}, Denied: denied, Unsupported: unsupported}
	for _, k := range []string{"five_hour", "seven_day"} {
		if w, ok := wins[k]; ok {
			out.Windows = append(out.Windows, w)
		}
	}
	if b, ok := env.Get("is_error").(bool); ok && b {
		out.IsError = true
	}
	return out
}

func init() {
	ParseClaudeUsageResultFn = func(stdout string, now float64) ClaudeUsageParse {
		p := ParseClaudeUsageResult(stdout, now)
		return ClaudeUsageParse{Windows: p.Windows, Denied: p.Denied, IsError: p.IsError, Unsupported: p.Unsupported}
	}
}
