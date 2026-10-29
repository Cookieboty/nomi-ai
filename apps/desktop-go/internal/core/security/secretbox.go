// Package security 对应 packages/core/src/security（secretStorage）。
// 字节级机密走 go-keyring（OS 钥匙串）；磁盘上的 `enc:` 前缀、失败关闭、旧明文兼容与 Node 一致。
package security

import (
	"encoding/base64"
	"sync"

	"github.com/zalando/go-keyring"
)

const keyringService = "Nomi"

// SecretBoxUnavailableError 对齐 SecretStorageUnavailableError
type SecretBoxUnavailableError struct{ Msg string }

func (e *SecretBoxUnavailableError) Error() string { return e.Msg }

// SecretBox 对齐 Node createSecretBox 的返回值
type SecretBox interface {
	CanEncrypt() bool
	Encrypt(value, unavailableMessage string) (string, error)
	Decrypt(value string) string
}

type keyringBox struct {
	service string
	account string
	mu      sync.Mutex
	n       int
}

// NewSecretBox：account 是逻辑分区（gateway / voice / mcp …）
func NewSecretBox(account string) SecretBox {
	return &keyringBox{service: keyringService, account: account}
}

func (b *keyringBox) CanEncrypt() bool {
	if err := keyring.Set(b.service, b.account+"__probe", "nomi-probe"); err != nil {
		return false
	}
	_ = keyring.Delete(b.service, b.account+"__probe")
	return true
}

func (b *keyringBox) Encrypt(value, unavailableMessage string) (string, error) {
	b.mu.Lock()
	b.n++
	id := b.account + ":" + itoa(b.n)
	b.mu.Unlock()
	if err := keyring.Set(b.service, id, value); err != nil {
		return "", &SecretBoxUnavailableError{Msg: unavailableMessage}
	}
	return "enc:" + base64.StdEncoding.EncodeToString([]byte(id)), nil
}

func (b *keyringBox) Decrypt(value string) string {
	if value == "" {
		return ""
	}
	if len(value) < 4 || value[:4] != "enc:" {
		return value
	}
	raw, err := base64.StdEncoding.DecodeString(value[4:])
	if err != nil {
		return ""
	}
	plain, err := keyring.Get(b.service, string(raw))
	if err != nil {
		return ""
	}
	return plain
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// MemoryBox 测试用（不碰系统钥匙串）
type MemoryBox struct {
	mu   sync.Mutex
	data map[string]string
	n    int
}

func NewMemoryBox() *MemoryBox { return &MemoryBox{data: map[string]string{}} }

func (m *MemoryBox) CanEncrypt() bool { return true }

func (m *MemoryBox) Encrypt(value, _ string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.n++
	id := "mem:" + itoa(m.n)
	m.data[id] = value
	return "enc:" + base64.StdEncoding.EncodeToString([]byte(id)), nil
}

func (m *MemoryBox) Decrypt(value string) string {
	if value == "" {
		return ""
	}
	if len(value) < 4 || value[:4] != "enc:" {
		return value
	}
	raw, err := base64.StdEncoding.DecodeString(value[4:])
	if err != nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.data[string(raw)]
}

// UseMockKeyring 启用 zalando/go-keyring 的进程内后端（单测）
func UseMockKeyring() { keyring.MockInit() }

// Set / Get / Delete 暴露给 migrate 把明文 API Key 直接写入钥匙串（按稳定 id）
func KeyringSet(account, secret string) error   { return keyring.Set(keyringService, account, secret) }
func KeyringGet(account string) (string, error) { return keyring.Get(keyringService, account) }
func KeyringDelete(account string) error {
	err := keyring.Delete(keyringService, account)
	return err
}
