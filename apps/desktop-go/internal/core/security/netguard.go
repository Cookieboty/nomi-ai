package security

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

// 对应 apps/desktop-electron/internal/core/src/security/netGuard.ts：出站 URL 只允许公网 http(s)，拒绝内嵌凭据与保留地址。

// LookupAddress 是 dns.LookupAddress。
type LookupAddress struct {
	Address string `json:"address"`
	Family  int    `json:"family"`
}

// LookupAll 返回主机名解析出的全部地址（dns.promises.lookup(host, {all:true})）。
type LookupAll func(host string) ([]LookupAddress, error)

// DefaultLookupAll 用系统解析器；未找到时消息与 Node getaddrinfo 一致。
func DefaultLookupAll(host string) ([]LookupAddress, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(context.Background(), host)
	if err != nil {
		var de *net.DNSError
		if errors.As(err, &de) && de.IsNotFound {
			return nil, errors.New("getaddrinfo ENOTFOUND " + host)
		}
		return nil, errors.New("getaddrinfo EAI_AGAIN " + host)
	}
	out := make([]LookupAddress, 0, len(ips))
	for _, ip := range ips {
		fam := 6
		if ip.IP.To4() != nil {
			fam = 4
		}
		out = append(out, LookupAddress{Address: ip.IP.String(), Family: fam})
	}
	return out, nil
}

// PublicURL 是 assertPublicHttpUrl 返回的 URL（hostname 为 WHATWG 形式，IPv6 带方括号）。
type PublicURL struct {
	URL      *url.URL
	Hostname string
}

// WhatwgHostname 是 `new URL(..).hostname`（IPv6 保留方括号）。
func WhatwgHostname(u *url.URL) string {
	h := u.Hostname()
	if strings.Contains(h, ":") {
		return "[" + h + "]"
	}
	return h
}

// AssertPublicHttpUrl 是 assertPublicHttpUrl。
func AssertPublicHttpUrl(raw string) (*PublicURL, error) {
	s := CleanURL(strings.TrimSpace(raw))
	colon := strings.Index(s, ":")
	scheme := ""
	if colon > 0 {
		scheme = strings.ToLower(s[:colon])
	}
	if !ValidScheme(s) {
		return nil, errors.New(i18n.T("electron.common.invalid-audio-url"))
	}
	if scheme != "http" && scheme != "https" {
		if IsSpecialScheme(scheme) && scheme != "file" {
			if _, err := gwnet.ParseURL("http" + s[colon:]); err != nil {
				return nil, errors.New(i18n.T("electron.common.invalid-audio-url"))
			}
		}
		if scheme == "file" && !FileHostValid(s[colon+1:]) {
			return nil, errors.New(i18n.T("electron.common.invalid-audio-url"))
		}
		return nil, errors.New(i18n.T("electron.common.audio-url-must-use-http-or-https"))
	}
	u, err := gwnet.ParseURL(s)
	if err != nil {
		return nil, errors.New(i18n.T("electron.common.invalid-audio-url"))
	}
	if u.User != nil {
		pw, _ := u.User.Password()
		if u.User.Username() != "" || pw != "" {
			return nil, errors.New(i18n.T("electron.common.audio-url-must-not-contain-credentials"))
		}
	}
	host := WhatwgHostname(u)
	if gwnet.IsPrivateHost(host) {
		return nil, errors.New(i18n.T("electron.common.audio-url-must-not-point-to-localhost-or"))
	}
	return &PublicURL{URL: u, Hostname: host}, nil
}

// AssertPublicHttpUrlResolved 是 assertPublicHttpUrlResolved。
func AssertPublicHttpUrlResolved(raw string, lookupAll LookupAll) (*PublicURL, error) {
	u, err := AssertPublicHttpUrl(raw)
	if err != nil {
		return nil, err
	}
	host := strings.TrimSuffix(strings.TrimPrefix(u.Hostname, "["), "]")
	if gwnet.ParseIPv4(host) != nil || gwnet.ParseIPv6(host) != nil {
		return u, nil
	}
	if lookupAll == nil {
		lookupAll = DefaultLookupAll
	}
	addrs, err := lookupAll(host)
	if err != nil {
		return nil, err
	}
	bad := len(addrs) == 0
	for _, a := range addrs {
		if gwnet.IsPrivateHost(a.Address) {
			bad = true
		}
	}
	if bad {
		return nil, errors.New(i18n.T("electron.common.audio-url-must-not-point-to-localhost-or"))
	}
	return u, nil
}

// IsSpecialScheme 是 WHATWG special scheme。
func IsSpecialScheme(s string) bool {
	switch s {
	case "http", "https", "ws", "wss", "ftp", "file":
		return true
	}
	return false
}

// ValidScheme：去除首尾 C0/空格与内部制表换行后，是否以 `alpha *( alnum / + / - / . ) ":"` 开头（无 base 的 new URL 前提）。
func ValidScheme(s string) bool {
	colon := strings.Index(s, ":")
	if colon <= 0 {
		return false
	}
	for i := 0; i < colon; i++ {
		c := s[i]
		alpha := (c|0x20) >= 'a' && (c|0x20) <= 'z'
		if i == 0 && !alpha {
			return false
		}
		if !alpha && !(c >= '0' && c <= '9') && c != '+' && c != '-' && c != '.' {
			return false
		}
	}
	return true
}

// FileHostValid 是 WHATWG file URL 的 host 校验（"file:" 之后的部分）：无 authority / 空 host 合法；
// host 不允许 userinfo 与端口，其余按特殊 scheme 的 host 解析规则。
func FileHostValid(rest string) bool {
	r := strings.ReplaceAll(rest, `\`, "/")
	if !strings.HasPrefix(r, "//") {
		return true
	}
	auth := r[2:]
	if i := strings.IndexAny(auth, "/?#"); i >= 0 {
		auth = auth[:i]
	}
	if auth == "" {
		return true
	}
	if strings.Contains(auth, "@") {
		return false
	}
	if i := strings.LastIndex(auth, ":"); i >= 0 && i > strings.LastIndex(auth, "]") {
		return false
	}
	_, err := gwnet.ParseURL("http://" + auth + "/")
	return err == nil
}

// CleanURL 是 URL 解析前的预处理：去首尾 C0 控制符与空格，删除内部 Tab / 换行。
func CleanURL(raw string) string {
	s := strings.Trim(raw, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\x0c\r\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f ")
	return strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
}
