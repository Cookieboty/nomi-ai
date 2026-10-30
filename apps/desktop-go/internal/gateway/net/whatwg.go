package net

import (
	"errors"
	"math/big"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// WHATWG URL host parsing (https://url.spec.whatwg.org/#host-parsing) so the
// hostnames seen by the guard and in its messages match Node's `new URL`.

var errInvalidHost = errors.New("invalid host")

// UTS #46 with the URL Standard's domain-to-ASCII flags (beStrict = false).
var uts46 = idna.New(
	idna.MapForLookup(),
	idna.StrictDomainName(false), // UseSTD3ASCIIRules = false
	idna.Transitional(false),
	idna.CheckHyphens(false),
	idna.CheckJoiners(true),
	idna.BidiRule(),
	idna.VerifyDNSLength(false),
)

const forbiddenDomain = "\x00\t\n\r #/:<>?@[\\]^|%\x7f"

func ipv4Number(p string) (*big.Int, bool) {
	if p == "" {
		return nil, false
	}
	base := 10
	if len(p) >= 2 && (p[:2] == "0x" || p[:2] == "0X") {
		p, base = p[2:], 16
	} else if len(p) >= 2 && p[0] == '0' {
		p, base = p[1:], 8
	}
	if p == "" {
		return big.NewInt(0), true
	}
	n, ok := new(big.Int).SetString(p, base)
	if !ok || n.Sign() < 0 || strings.ContainsAny(p, "+-_") {
		return nil, false
	}
	return n, true
}

func endsInNumber(h string) bool {
	parts := strings.Split(h, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	_, ok := ipv4Number(last)
	return ok && (len(last) < 2 || last[:2] == "0x" || last[:2] == "0X")
}

func parseWhatwgIPv4(h string) (string, error) {
	parts := strings.Split(h, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", errInvalidHost
	}
	nums := make([]*big.Int, len(parts))
	for i, p := range parts {
		n, ok := ipv4Number(p)
		if !ok {
			return "", errInvalidHost
		}
		nums[i] = n
	}
	b255 := big.NewInt(255)
	for _, n := range nums[:len(nums)-1] {
		if n.Cmp(b255) > 0 {
			return "", errInvalidHost
		}
	}
	limit := new(big.Int).Lsh(big.NewInt(1), uint(8*(5-len(nums))))
	if nums[len(nums)-1].Cmp(limit) >= 0 {
		return "", errInvalidHost
	}
	v := new(big.Int).Set(nums[len(nums)-1])
	for i, n := range nums[:len(nums)-1] {
		v.Add(v, new(big.Int).Lsh(n, uint(8*(3-i))))
	}
	x := v.Uint64()
	return strconv.Itoa(int(x>>24&255)) + "." + strconv.Itoa(int(x>>16&255)) + "." + strconv.Itoa(int(x>>8&255)) + "." + strconv.Itoa(int(x&255)), nil
}

func serializeIPv6(g []int) string {
	best, bestLen := -1, 1
	for i := 0; i < 8; {
		if g[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && g[j] == 0 {
			j++
		}
		if j-i > bestLen {
			best, bestLen = i, j-i
		}
		i = j
	}
	var b strings.Builder
	for i := 0; i < 8; i++ {
		if i == best {
			if i == 0 {
				b.WriteString("::")
			} else {
				b.WriteString(":")
			}
			i += bestLen - 1
			continue
		}
		b.WriteString(strconv.FormatInt(int64(g[i]), 16))
		if i != 7 {
			b.WriteString(":")
		}
	}
	return b.String()
}

// WhatwgHost is the URL Standard host parser for special schemes; it returns
// the serialized host (IPv6 in brackets) as `new URL(..).hostname` gives it.
func WhatwgHost(in string) (string, error) {
	if strings.HasPrefix(in, "[") {
		if !strings.HasSuffix(in, "]") || strings.Contains(in, "%") {
			return "", errInvalidHost
		}
		g := ParseIPv6(in[1 : len(in)-1])
		if g == nil {
			return "", errInvalidHost
		}
		return "[" + serializeIPv6(g) + "]", nil
	}
	dec, err := url.PathUnescape(in)
	if err != nil {
		return "", errInvalidHost
	}
	ascii, err := uts46.ToASCII(dec)
	if err != nil || ascii == "" || strings.ContainsAny(ascii, forbiddenDomain) {
		return "", errInvalidHost
	}
	for _, r := range ascii {
		if r < 0x20 {
			return "", errInvalidHost
		}
	}
	if endsInNumber(ascii) {
		return parseWhatwgIPv4(ascii)
	}
	return ascii, nil
}

// ParseURL is `new URL(raw)` for http(s) upstream addresses: the authority is
// split and the host normalised as WHATWG does (default ports dropped), then
// the rest is parsed with net/url.
func ParseURL(raw string) (*url.URL, error) {
	raw = strings.Trim(raw, "\x00\t\n\r\f ")
	raw = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(raw)
	colon := strings.Index(raw, ":")
	if colon <= 0 {
		return nil, errInvalidHost
	}
	scheme := strings.ToLower(raw[:colon])
	if scheme != "http" && scheme != "https" {
		return url.Parse(raw)
	}
	rest := strings.TrimLeft(raw[colon+1:], "/\\")
	end := strings.IndexAny(rest, "/?#\\")
	if end < 0 {
		end = len(rest)
	}
	auth, tail := rest[:end], rest[end:]
	userinfo := ""
	if at := strings.LastIndex(auth, "@"); at >= 0 {
		userinfo, auth = auth[:at+1], auth[at+1:]
	}
	hostPart, port := auth, ""
	if i := strings.LastIndex(auth, ":"); i >= 0 && !strings.HasSuffix(auth, "]") {
		hostPart, port = auth[:i], auth[i+1:]
	}
	if hostPart == "" {
		return nil, errInvalidHost
	}
	h, err := WhatwgHost(hostPart)
	if err != nil {
		return nil, err
	}
	if port != "" {
		if strings.Trim(port, "0123456789") != "" {
			return nil, errInvalidHost
		}
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return nil, errInvalidHost
		}
		port = strconv.Itoa(n)
		if (scheme == "http" && n == 80) || (scheme == "https" && n == 443) {
			port = ""
		}
	}
	host := h
	if port != "" {
		host += ":" + port
	}
	if tail == "" {
		tail = "/"
	}
	return url.Parse(scheme + "://" + userinfo + host + strings.ReplaceAll(tail, "\\", "/"))
}
