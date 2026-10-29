// Package gwstore 对应 packages/core/src/gateway 的 GatewayStore.ts + migrate.ts：
// userData/gateway/store.json（同路径、同 JSON 形态、同 enc/encryption 字段语义），
// 以及 2.0.4 的 ai-providers.json / cli-providers/<kind>/store.json 一次性迁移。
package gwstore

import (
	"encoding/base64"
	"errors"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

// Cipher = ai-runtime 的 SecretCipher（kind 'safeStorage' | 'none'）
type Cipher = providers.SecretCipher

var errUndecryptable = errors.New("undecryptable")

// boxCipher：Go 宿主的 safeStorage —— 系统钥匙串主密钥 + AES-GCM（security.SecretBox）。
// 磁盘值与 Electron 一样是 base64(密文)，encryption 记为 'safeStorage'；
// SecretBox 的 `enc:` 前缀不落盘（Node 的 safeStorage 密文没有前缀）。
type boxCipher struct{ box security.SecretBox }

func (boxCipher) Kind() string { return "safeStorage" }
func (c boxCipher) Encrypt(plain string) (string, error) {
	s, err := c.box.Encrypt(plain, "safeStorage unavailable")
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(s, "enc:"), nil
}
func (c boxCipher) Decrypt(stored string) (string, error) {
	if stored == "" {
		return "", errUndecryptable
	}
	p := c.box.Decrypt("enc:" + stored)
	if p == "" {
		return "", errUndecryptable
	}
	return p, nil
}

// NewCipher = createSafeStorageCipher：钥匙串可用 → 'safeStorage'，否则 base64 明文 'none'
func NewCipher(box security.SecretBox) Cipher {
	if box == nil || !box.CanEncrypt() {
		return providers.PlaintextCipher
	}
	return boxCipher{box}
}

// LegacyCliKeyDecryptor = legacyCliKeyDecryptor：先按 safeStorage 解，失败按明文 base64。
// Go 侧 secrets = 同一个 safeStorage（批 3 迁移已把 Electron 密文改写成 Go 的 safeStorage 密文）。
func LegacyCliKeyDecryptor(c Cipher) func(enc string) string {
	return func(enc string) string {
		if enc == "" {
			return ""
		}
		if c != nil && c.Kind() == "safeStorage" {
			if p, err := c.Decrypt(enc); err == nil {
				return p
			}
		}
		return providers.NodeBase64Decode(enc)
	}
}

// KeyringCompat：2.0.5 预览版批 3 迁移写过 encryption:"keyring"（enc = base64(钥匙串账号)）。
// Node 没有这种 kind（读作 null）；Go 继续能读，下次重新加密时写回 Node 形态（偏差 D-B4d-5b）。
func keyringCompat(enc string) (string, bool) {
	b, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", false
	}
	p, err := security.KeyringGet(string(b))
	if err != nil || p == "" {
		return "", false
	}
	return p, true
}
