// Package assetproto 是 chat-asset:// 与 character-pack:// 两个本地协议的 1:1 移植
// （apps/desktop-electron/src/host/assetProtocol.ts、packages/core/src/character/packProtocol.ts）。
package assetproto

import (
	"strings"
	"unicode/utf8"
)

// whatwgURL 是 Node `new URL()` 对非特殊 scheme（chat-asset / character-pack）解析结果中本包用到的部分。
type whatwgURL struct {
	Protocol string // 含尾部冒号，小写
	Hostname string // 不透明主机：保留大小写
	Pathname string
}

func isASCIIAlpha(c byte) bool { return c|0x20 >= 'a' && c|0x20 <= 'z' }

// 不透明主机的禁止码点（WHATWG forbidden host code point，不含 %）
const forbiddenHost = "\x00\t\n\r #/:<>?@[\\]^|"

// parseURL 仅覆盖本包需要的 WHATWG 语义：非特殊 scheme 的 authority / 路径 / 点段规范化。
// 特殊 scheme（http 等）只需判定 protocol，不展开主机解析。ok=false 对应 Node 抛 TypeError。
func parseURL(raw string) (whatwgURL, bool) {
	// 去首尾 C0 控制符与空格，删去所有 tab / 换行
	s := strings.TrimFunc(raw, func(r rune) bool { return r <= 0x20 })
	s = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
	i := strings.IndexByte(s, ':')
	if i <= 0 || !isASCIIAlpha(s[0]) {
		return whatwgURL{}, false
	}
	for j := 1; j < i; j++ {
		c := s[j]
		if !(isASCIIAlpha(c) || c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.') {
			return whatwgURL{}, false
		}
	}
	u := whatwgURL{Protocol: strings.ToLower(s[:i]) + ":"}
	switch u.Protocol {
	case "http:", "https:", "ws:", "wss:", "ftp:", "file:":
		return u, true // 调用方只比 protocol，必然不等
	}
	rest := s[i+1:]
	if !strings.HasPrefix(rest, "//") {
		// 不透明路径 / 无 authority：hostname 为空
		return u, true
	}
	rest = rest[2:]
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	auth, tail := rest[:end], rest[end:]
	if at := strings.LastIndexByte(auth, '@'); at >= 0 {
		auth = auth[at+1:]
	}
	host := auth
	if c := strings.LastIndexByte(auth, ':'); c >= 0 && !strings.Contains(auth, "]") {
		host = auth[:c]
		for _, ch := range auth[c+1:] {
			if ch < '0' || ch > '9' {
				return whatwgURL{}, false
			}
		}
	}
	if strings.ContainsAny(host, forbiddenHost) {
		return whatwgURL{}, false
	}
	u.Hostname = percentEncode(host, false)
	if q := strings.IndexAny(tail, "?#"); q >= 0 {
		tail = tail[:q]
	}
	if tail == "" {
		return u, true
	}
	u.Pathname = normalizePath(tail)
	return u, true
}

func isDot(seg string) bool { return seg == "." || strings.EqualFold(seg, "%2e") }
func isDotDot(seg string) bool {
	switch strings.ToLower(seg) {
	case "..", ".%2e", "%2e.", "%2e%2e":
		return true
	}
	return false
}

// normalizePath：WHATWG path state（非特殊 scheme，仅 / 为分隔符），并做路径百分号编码
func normalizePath(p string) string {
	segs := strings.Split(p[1:], "/")
	var out []string
	for k, seg := range segs {
		last := k == len(segs)-1
		switch {
		case isDotDot(seg):
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		case isDot(seg):
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, percentEncode(seg, true))
		}
	}
	return "/" + strings.Join(out, "/")
}

// percentEncode：C0 控制集（主机）或 path 编码集（路径）；非 ASCII 按 UTF-8 编码
func percentEncode(s string, path bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		enc := c < 0x20 || c >= 0x7f
		if path && !enc {
			enc = strings.IndexByte(" \"#<>?`{}", c) >= 0
		}
		if enc {
			b.WriteString("%" + strings.ToUpper(hex2(c)))
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func hex2(c byte) string { const h = "0123456789abcdef"; return string([]byte{h[c>>4], h[c&15]}) }

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c|0x20 >= 'a' && c|0x20 <= 'f':
		return c | 0x20 - 'a' + 10, true
	}
	return 0, false
}

// decodeURIComponent：JS 语义——非法 % 序列或解出非法 UTF-8 时抛 URIError（ok=false）
func decodeURIComponent(s string) (string, bool) {
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b = append(b, s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", false
		}
		h, ok1 := unhex(s[i+1])
		l, ok2 := unhex(s[i+2])
		if !ok1 || !ok2 {
			return "", false
		}
		b = append(b, h<<4|l)
		i += 2
	}
	if !utf8.Valid(b) {
		return "", false
	}
	return string(b), true
}
