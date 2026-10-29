// Package privacy ports packages/gateway/src/privacy (secret masking).
//
// All offsets are JS (UTF-16) indices. Regexes run over u.Projection of the
// text (one byte per UTF-16 unit, ASCII kept, non-ASCII whitespace → \v, other
// non-ASCII → \x01), which is exact because every pattern's literals are ASCII
// and JS non-unicode /i never folds non-ASCII onto ASCII. Leading lookbehinds,
// \b and trailing fixed-width lookaheads (unsupported by RE2) are checked by
// hand while scanning start positions in order, as JS does.
package privacy

import (
	"regexp"
	"sort"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RulesVersion is RULES_VERSION.
const RulesVersion = 2

// PrivacyKinds is PRIVACY_KINDS.
var PrivacyKinds = []string{"API_KEY", "TOKEN", "PRIVATE_KEY", "PASSWORD", "CUSTOM"}

// SecretSpan is SecretSpan.
type SecretSpan struct {
	Start, End int
	Kind       string
	By         string
}

// Obj is the JS shape {start,end,kind,by}.
func (s SecretSpan) Obj() *u.Obj {
	return u.NewObj("start", float64(s.Start), "end", float64(s.End), "kind", s.Kind, "by", s.By)
}

const ws = `[` + u.ProjWS + `]`

func re(s string) *regexp.Regexp {
	// JS \s / \S over a Projection: inside a class they expand to the class body
	var b strings.Builder
	in := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			n := s[i+1]
			i++
			switch {
			case n == 's' && in:
				b.WriteString(u.ProjWS)
			case n == 's':
				b.WriteString(ws)
			case n == 'S' && !in:
				b.WriteString(`[^` + u.ProjWS + `]`)
			default:
				b.WriteByte(c)
				b.WriteByte(n)
			}
		case c == '[' && !in:
			in = true
			b.WriteByte(c)
			if i+1 < len(s) && s[i+1] == '^' {
				b.WriteByte('^')
				i++
			}
			if i+1 < len(s) && s[i+1] == ']' {
				b.WriteString(`\]`)
				i++
			}
		case c == ']' && in:
			in = false
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	return regexp.MustCompile(b.String())
}

type rule struct {
	kind    string
	re      *regexp.Regexp
	group   int
	markers []string
	also    []string
	back    int
	ahead   int
	ok      func(v u.Units) bool
	strict  bool
	// leading (?<![A-Za-z0-9_-]) / \b (prev not [A-Za-z0-9_])
	notAfter func(c byte) bool
	// trailing (?![…]) checked at match end
	notBefore func(c byte) bool
}

func isAlnum(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
}
func isWord(c byte) bool  { return isAlnum(c) || c == '_' }
func isBound(c byte) bool { return isWord(c) || c == '-' }

var (
	dummyRe   = re(`(?i)^(?:x+|\*+|\.+|password|passwd|pass|secret|token|changeme|example|test|dummy|redacted|your[-_]?[a-z_-]*|<[^>]*>|\$\{?[A-Za-z0-9_.-]+\}?|%[A-Za-z0-9_]+%|\{\{[^}]*\}\}|\[[^\]]*\])$`)
	uuidOnly  = re(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hashOnly  = re(`(?i)^[0-9a-f]{40}$|^[0-9a-f]{64}$`)
	integrity = re(`^sha(?:1|256|384|512)-`)
	digitsRe  = re(`^[0-9]+$`)
	notCred   = re(`(?i)(?:_id|id|_hash|hash|page_?token|next_?token|csrf_?token|idempotency_?key|_?keys?_?count)$`)
	idCore    = re(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-fA-F]{32,}`)
)

// repeated is /^(.)\1+$/ (`.` excludes line terminators).
func repeated(v u.Units) bool {
	if len(v) < 2 {
		return false
	}
	c := v[0]
	if c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029 {
		return false
	}
	for _, x := range v[1:] {
		if x != c {
			return false
		}
	}
	return true
}

func notDummy(v u.Units) bool {
	return !dummyRe.MatchString(u.Projection(v)) && !repeated(v)
}

func hasLetter(p string) bool {
	return strings.IndexFunc(p, func(r rune) bool { return r < 128 && (r|32) >= 'a' && (r|32) <= 'z' }) >= 0
}
func hasDigit(p string) bool {
	return strings.IndexFunc(p, func(r rune) bool { return r >= '0' && r <= '9' }) >= 0
}

func secretValue(v u.Units) bool {
	p := u.Projection(v)
	return hasLetter(p) && hasDigit(p) && notDummy(v)
}

func passwordValue(v u.Units) bool {
	if len(v) < 4 || !notDummy(v) {
		return false
	}
	switch v[0] {
	case '$', '%', '{', '<', '[':
		return false
	}
	return true
}

// Entropy is entropy(): Shannon entropy over code points, divided by .length.
func Entropy(s string) float64 { return entropyUnits(u.ToUnits(s)) }

func entropyUnits(us u.Units) float64 {
	var order []string
	n := map[string]int{}
	for i := 0; i < len(us); i++ {
		k := string(rune(us[i]))
		if us[i] >= 0xD800 && us[i] <= 0xDBFF && i+1 < len(us) && us[i+1] >= 0xDC00 && us[i+1] <= 0xDFFF {
			k = u.FromUnits(us[i : i+2])
			i++
		} else if us[i] >= 0xD800 && us[i] <= 0xDFFF {
			k = u.FromUnits(us[i : i+1])
		}
		if _, ok := n[k]; !ok {
			order = append(order, k)
		}
		n[k]++
	}
	h := 0.0
	for _, k := range order {
		p := float64(n[k]) / float64(len(us))
		h -= float64(p * log2(p))
	}
	return h
}

func strictValue(v u.Units) bool {
	if len(v) < 12 || !notDummy(v) {
		return false
	}
	p := u.Projection(v)
	if hashOnly.MatchString(p) || uuidOnly.MatchString(p) {
		return false
	}
	if integrity.MatchString(p) || strings.HasPrefix(p, "data:") {
		return false
	}
	if digitsRe.MatchString(p) {
		return false
	}
	return entropyUnits(v) >= 3
}

var rules = []*rule{
	{kind: "PRIVATE_KEY", re: re(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\x00-\x7f]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`),
		markers: []string{"PRIVATE KEY"}, ahead: 16384},
	{kind: "API_KEY", re: re(`sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`), markers: []string{"sk-"}, notAfter: isBound},
	{kind: "API_KEY", re: re(`[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}`), markers: []string{"_sk_"}, ok: secretValue, notAfter: isBound},
	{kind: "API_KEY", re: re(`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`), markers: []string{"_live_", "_test_"}, notAfter: isBound},
	{kind: "TOKEN", re: re(`(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})`),
		markers: []string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-"}, notAfter: isBound},
	{kind: "API_KEY", re: re(`AIza[0-9A-Za-z_-]{35}`), markers: []string{"AIza"}, notAfter: isBound, notBefore: isBound},
	{kind: "API_KEY", re: re(`(?:AKIA|ASIA)[0-9A-Z]{16}`), markers: []string{"AKIA", "ASIA"}, notAfter: isBound, notBefore: isAlnum},
	{kind: "TOKEN", re: re(`xox[abpr]-[A-Za-z0-9-]{10,}`), markers: []string{"xox"}, ok: secretValue, notAfter: isBound},
	{kind: "API_KEY", re: re(`(?:hf_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})`), markers: []string{"hf_", "xai-", "gsk_"}, notAfter: isBound},
	{kind: "TOKEN", re: re(`nomi-(?:gw|tab)-[A-Za-z0-9_-]{6,}`), markers: []string{"nomi-"}, notAfter: isBound},
	{kind: "TOKEN", re: re(`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`), markers: []string{"eyJ"}, ahead: 8192, notAfter: isBound},
	{kind: "TOKEN", re: re(`(?i)Bearer\s+([A-Za-z0-9._~+/=-]{16,})`), group: 1, markers: []string{"Bearer", "bearer", "BEARER"}, ok: secretValue, notAfter: isWord},
	{kind: "PASSWORD", re: re("(?i)[a-z][a-z0-9+.-]*://[^\\s:@/\"'`]*:([^\\s@/\"'`]+)@"), group: 1, markers: []string{"://"}, also: []string{"@"}, ok: passwordValue, notAfter: isWord},
	{kind: "TOKEN", re: re(`(?i)[?&](?:key|api_key|apikey|access_token|token|client_secret)=([^&\s"'#]{12,})`), group: 1,
		markers: []string{"key=", "token=", "secret=", "KEY=", "TOKEN=", "SECRET=", "Key=", "Token="}, ok: secretValue},
	{kind: "PASSWORD", re: re(`(?:^|[\s"'{,;(])((?:[A-Za-z_][A-Za-z0-9_]*?)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|key|token|secret|password|passwd))["']?\s*[:=]\s*["']?([^\s"',;)}]+)`),
		group: 2, markers: []string{"=", ":"}, ok: strictValue, strict: true},
}

// matchAll is text.matchAll(r.re) over a projection, with the hand-checked
// lookarounds. Each result is a submatch index slice.
func (r *rule) matchAll(text string) [][]int {
	if r.notAfter == nil && r.notBefore == nil {
		return r.re.FindAllStringSubmatchIndex(text, -1)
	}
	var out [][]int
	for q := 0; q <= len(text); {
		loc := r.re.FindStringSubmatchIndex(text[q:])
		if loc == nil {
			break
		}
		for i := range loc {
			if loc[i] >= 0 {
				loc[i] += q
			}
		}
		p := loc[0]
		if (r.notAfter != nil && p > 0 && r.notAfter(text[p-1])) ||
			(r.notBefore != nil && loc[1] < len(text) && r.notBefore(text[loc[1]])) {
			q = p + 1
			continue
		}
		out = append(out, loc)
		q = loc[1]
		if loc[1] == loc[0] {
			q++
		}
	}
	return out
}

func idRanges(p string) [][2]int {
	var out [][2]int
	for q := 0; q <= len(p); {
		loc := idCore.FindStringIndex(p[q:])
		if loc == nil {
			break
		}
		a, b := loc[0]+q, loc[1]+q
		if (a > 0 && isAlnum(p[a-1])) || (b < len(p) && isAlnum(p[b])) {
			q = a + 1
			continue
		}
		out = append(out, [2]int{a, b})
		q = b
	}
	return out
}

type markerRules struct {
	mk    string
	rules []*rule
}

var (
	byMarker   []markerRules // insertion order of BY_MARKER
	markerRe   *regexp.Regexp
	candidates = map[string][]markerRules{}
)

func init() {
	idx := map[string]int{}
	for _, r := range rules {
		if r.strict {
			continue
		}
		for _, m := range r.markers {
			if i, ok := idx[m]; ok {
				byMarker[i].rules = append(byMarker[i].rules, r)
			} else {
				idx[m] = len(byMarker)
				byMarker = append(byMarker, markerRules{m, []*rule{r}})
			}
		}
	}
	var lows []string
	seen := map[string]bool{}
	for _, e := range byMarker {
		l := strings.ToLower(e.mk)
		if !seen[l] {
			seen[l] = true
			lows = append(lows, l)
		}
	}
	sorted := append([]string(nil), lows...)
	sort.SliceStable(sorted, func(a, b int) bool { return len(sorted[a]) > len(sorted[b]) })
	q := make([]string, len(sorted))
	for i, m := range sorted {
		q[i] = regexp.QuoteMeta(m)
	}
	markerRe = regexp.MustCompile(`(?i)` + strings.Join(q, "|"))
	for _, low := range lows {
		for _, e := range byMarker {
			if strings.HasPrefix(low, strings.ToLower(e.mk)) {
				candidates[low] = append(candidates[low], e)
			}
		}
	}
}

func markerHits(p string) map[*rule][]int {
	out := map[*rule][]int{}
	for q := 0; q < len(p); {
		loc := markerRe.FindStringIndex(p[q:])
		if loc == nil {
			break
		}
		i, j := loc[0]+q, loc[1]+q
		q = i + 1
		m := strings.ToLower(p[i:j])
		for _, c := range candidates[m] {
			if !strings.HasPrefix(p[i:], c.mk) {
				continue
			}
			for _, r := range c.rules {
				out[r] = append(out[r], i, len(c.mk))
			}
		}
	}
	return out
}

func windows(n int, r *rule, hits []int) [][2]int {
	back, ahead := 64, 512
	if r.back > 0 {
		back = r.back
	}
	if r.ahead > 0 {
		ahead = r.ahead
	}
	half := float64(n) / 2
	var out [][2]int
	total := 0
	last := -1
	for k := 0; k < len(hits); k += 2 {
		i, m := hits[k], hits[k+1]
		a := max(0, i-back)
		b := min(n, i+m+ahead)
		if last >= 0 && a <= out[last][1] {
			if b > out[last][1] {
				total += b - out[last][1]
				out[last][1] = b
			}
		} else {
			out = append(out, [2]int{a, b})
			last = len(out) - 1
			total += b - a
		}
		if float64(total) > half {
			return nil
		}
	}
	return out
}

// RuleSpans is ruleSpans(s, {strict}).
func RuleSpans(s string, strict bool) []SecretSpan { return ruleSpansUnits(u.ToUnits(s), strict) }

func ruleSpansUnits(us u.Units, strict bool) []SecretSpan {
	p := u.Projection(us)
	type cspan struct {
		SecretSpan
		contextual bool
	}
	var out []cspan
	hits := markerHits(p)
	for _, r := range rules {
		var ws [][2]int
		if r.strict {
			if !strict {
				continue
			}
			any := false
			for _, m := range r.markers {
				if strings.Contains(p, m) {
					any = true
				}
			}
			if !any {
				continue
			}
			ws = nil
		} else {
			at, ok := hits[r]
			if !ok {
				continue
			}
			ws = windows(len(p), r, at)
		}
		skip := false
		for _, m := range r.also {
			if !strings.Contains(p, m) {
				skip = true
			}
		}
		if skip {
			continue
		}
		if ws == nil {
			ws = [][2]int{{0, len(p)}}
		}
		for _, w := range ws {
			from, to := w[0], w[1]
			text := p[from:to]
			for _, m := range r.matchAll(text) {
				vs, ve := m[0], m[1]
				if r.group > 0 {
					vs, ve = m[2*r.group], m[2*r.group+1]
				}
				if vs < 0 || ve == vs {
					continue
				}
				if r.strict && m[2] >= 0 && notCred.MatchString(text[m[2]:m[3]]) {
					continue
				}
				v := us[from+vs : from+ve]
				if r.ok != nil && !r.ok(v) {
					continue
				}
				start := from + vs
				by := "rule"
				if r.strict {
					by = "strict"
				}
				out = append(out, cspan{SecretSpan{start, start + len(v), r.kind, by}, r.group > 0})
			}
		}
	}
	res := []SecretSpan{}
	if len(out) == 0 {
		return res
	}
	ids := idRanges(p)
	for _, sp := range out {
		if len(ids) > 0 && !sp.contextual {
			inside := false
			for _, ab := range ids {
				if sp.Start >= ab[0] && sp.End <= ab[1] {
					inside = true
					break
				}
			}
			if inside {
				continue
			}
		}
		res = append(res, sp.SecretSpan)
	}
	return res
}

// MergeSpans is mergeSpans.
func MergeSpans(spans []SecretSpan) []SecretSpan {
	if len(spans) < 2 {
		return spans
	}
	sorted := append([]SecretSpan(nil), spans...)
	sort.SliceStable(sorted, func(a, b int) bool {
		if sorted[a].Start != sorted[b].Start {
			return sorted[a].Start < sorted[b].Start
		}
		return sorted[a].End > sorted[b].End
	})
	var out []SecretSpan
	end := -1
	for _, sp := range sorted {
		if sp.Start < end {
			continue
		}
		out = append(out, sp)
		end = sp.End
	}
	return out
}

// HasSecret is hasSecret.
func HasSecret(s string, strict bool) bool { return len(RuleSpans(s, strict)) > 0 }
