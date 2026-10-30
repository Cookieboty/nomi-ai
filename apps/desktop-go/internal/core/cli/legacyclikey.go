package cli

import (
	"encoding/base64"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"strings"
)

// SecretsPort = host-ports SecretsPort 的 available / decrypt 子集（batch 4/5 宿主端口：Electron safeStorage）。
type SecretsPort interface {
	Available() bool
	Decrypt(b []byte) (string, error)
}

// nodeBase64 = Buffer.from(s, 'base64')：宽松解码（忽略非法字符，遇到 '=' 停止，容忍缺省填充 / URL 安全字母表）。
func nodeBase64(s string) []byte {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/':
			b.WriteRune(r)
		case r == '-':
			b.WriteByte('+')
		case r == '_':
			b.WriteByte('/')
		case r == '=':
			goto done
		}
	}
done:
	t := b.String()
	if len(t)%4 == 1 {
		t = t[:len(t)-1]
	}
	out, _ := base64.RawStdEncoding.DecodeString(t)
	return out
}

// LegacyCliKeyDecryptor = legacyCliKeyDecryptor。
func LegacyCliKeyDecryptor(secrets SecretsPort) func(enc string) string {
	return func(enc string) string {
		if enc == "" {
			return ""
		}
		if s, ok := func() (s string, ok bool) {
			defer func() {
				if recover() != nil {
					ok = false
				}
			}()
			if secrets.Available() {
				v, err := secrets.Decrypt(nodeBase64(enc))
				if err != nil {
					return "", false
				}
				return v, true
			}
			return "", false
		}(); ok {
			return s
		}
		return nodeproc.DecodeChunk(nodeBase64(enc))
	}
}
