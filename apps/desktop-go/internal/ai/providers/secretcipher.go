package providers

import (
	"encoding/base64"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// SecretCipher 对应 secretCipher.ts：'safeStorage' = 系统级加密；'none' = 未加密回退（仅 base64）
type SecretCipher interface {
	Kind() string
	Encrypt(plain string) (string, error)
	Decrypt(stored string) (string, error)
}

// SafeStorageLike：Electron safeStorage 的最小接口（Go 宿主由系统钥匙串实现）
type SafeStorageLike interface {
	IsEncryptionAvailable() bool
	EncryptString(plain string) ([]byte, error)
	DecryptString(buf []byte) (string, error)
	// GetSelectedStorageBackend：可选，没有返回 ""
	GetSelectedStorageBackend() string
}

type plaintext struct{}

func (plaintext) Kind() string { return "none" }
func (plaintext) Encrypt(plain string) (string, error) {
	return base64.StdEncoding.EncodeToString([]byte(u.ToWellFormed(plain))), nil
}
func (plaintext) Decrypt(stored string) (string, error) { return nodeBase64Decode(stored), nil }

// PlaintextCipher：plaintextCipher
var PlaintextCipher SecretCipher = plaintext{}

type safeCipher struct{ s SafeStorageLike }

func (safeCipher) Kind() string { return "safeStorage" }
func (c safeCipher) Encrypt(plain string) (string, error) {
	b, err := c.s.EncryptString(plain)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}
func (c safeCipher) Decrypt(stored string) (string, error) {
	return c.s.DecryptString([]byte(nodeBase64Decode(stored)))
}

// CreateSafeStorageCipher：Linux 下 basic_text / unknown 后端视为不可用
func CreateSafeStorageCipher(s SafeStorageLike) (c SecretCipher) {
	if s == nil {
		return PlaintextCipher
	}
	available := func() (ok bool) {
		defer func() {
			if recover() != nil {
				ok = false
			}
		}()
		ok = s.IsEncryptionAvailable()
		if b := s.GetSelectedStorageBackend(); b == "basic_text" || b == "unknown" {
			ok = false
		}
		return ok
	}()
	if !available {
		return PlaintextCipher
	}
	return safeCipher{s}
}

// MaskSecret：`sk-abc…wxyz`；短 key 只保留末 2 位（按 UTF-16 单元，同 JS slice）
func MaskSecret(secret string) string {
	s := u.JSTrim(secret)
	n := u.UTF16Len(s)
	if n <= 8 {
		r := n - 2
		if r < 1 {
			r = 1
		}
		return strings.Repeat("•", r) + u.UTF16Tail(s, 2)
	}
	return u.UTF16Slice0(s, 3) + "…" + u.UTF16Tail(s, 4)
}

// nodeBase64Decode：Buffer.from(s, 'base64').toString('utf8')——宽松解码（忽略非法字符、
// 允许缺 padding / url-safe 字母表），非法 UTF-8 替换为 U+FFFD
func nodeBase64Decode(s string) string {
	var clean []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			clean = append(clean, c)
		case c == '-':
			clean = append(clean, '+')
		case c == '_':
			clean = append(clean, '/')
		case c == '=':
			i = len(s) // Node 在第一个 '=' 处停止
		}
	}
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	b, _ := base64.RawStdEncoding.DecodeString(string(clean))
	return bufferToUTF8(b)
}

// bufferToUTF8：Buffer#toString('utf8')（WHATWG 替换规则，但不吞 BOM）
func bufferToUTF8(b []byte) string {
	bom := ""
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		bom, b = "\uFEFF", b[3:]
	}
	d := &u.TextDecoder{}
	return bom + d.Decode(b) + d.Flush()
}
