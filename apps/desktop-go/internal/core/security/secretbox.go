// Package security 对应 apps/desktop-electron/internal/core/src/security（secretStorage）。
// 字节级机密走 go-keyring（OS 钥匙串）；磁盘上的 `enc:` 前缀、失败关闭、旧明文兼容与 Node 一致。
package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
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

// keyringBox 对齐 Electron safeStorage 的落盘形态：钥匙串里只存一把主密钥（同 Electron 的
// "<App> Safe Storage" 口令），每个值加密后整体写进 `enc:<base64 密文>`，磁盘值自带全部信息，
// 不依赖任何计数器或 id 表——跨启动、多实例、多账户都不会互相覆盖。
//
// 密文：`g10` + 12 字节随机 nonce + AES-256-GCM(值)。和 Node 一样，同一明文每次加密结果不同。
// 旧格式（2.0.5 预览里的 `enc:base64("<account>:<n>")` 钥匙串引用）仍可解密。
type keyringBox struct {
	service string
	account string
	mu      sync.Mutex
	key     []byte
}

const (
	masterKeyAccount = "safe-storage-key"
	cipherTag        = "g10"
)

// NewSecretBox：account 只用于识别调用方（gateway / voice / extensions / migrate …），
// 所有 box 共用同一把主密钥，和 Electron 全进程共用一个 safeStorage 一样。
func NewSecretBox(account string) SecretBox {
	return &keyringBox{service: keyringService, account: account}
}

// masterKey：读钥匙串里的主密钥，没有就生成 32 字节随机密钥写入；create=false 时只读。
func (b *keyringBox) masterKey(create bool) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.key != nil {
		return b.key, nil
	}
	masterMu.Lock()
	defer masterMu.Unlock()
	if v, err := keyring.Get(b.service, masterKeyAccount); err == nil {
		if k, err := base64.StdEncoding.DecodeString(v); err == nil && len(k) == 32 {
			b.key = k
			return k, nil
		}
	}
	if !create {
		return nil, errors.New("no master key")
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	if err := keyring.Set(b.service, masterKeyAccount, base64.StdEncoding.EncodeToString(k)); err != nil {
		return nil, err
	}
	b.key = k
	return k, nil
}

// 同进程多个 box 首次生成主密钥时串行，避免两把密钥互相覆盖
var masterMu sync.Mutex

func (b *keyringBox) seal(value string) ([]byte, error) {
	k, err := b.masterKey(true)
	if err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte(cipherTag), nonce...)
	return g.Seal(out, nonce, []byte(value), nil), nil
}

func (b *keyringBox) open(raw []byte) (string, bool) {
	k, err := b.masterKey(false)
	if err != nil {
		return "", false
	}
	blk, err := aes.NewCipher(k)
	if err != nil {
		return "", false
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return "", false
	}
	raw = raw[len(cipherTag):]
	if len(raw) < g.NonceSize() {
		return "", false
	}
	pt, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], nil)
	if err != nil {
		return "", false
	}
	return string(pt), true
}

// CanEncrypt：同 Node，做一次真实加密探测
func (b *keyringBox) CanEncrypt() bool {
	_, err := b.seal("nomi-probe")
	return err == nil
}

func (b *keyringBox) Encrypt(value, unavailableMessage string) (string, error) {
	ct, err := b.seal(value)
	if err != nil {
		return "", &SecretBoxUnavailableError{Msg: unavailableMessage}
	}
	return "enc:" + base64.StdEncoding.EncodeToString(ct), nil
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
	if len(raw) > len(cipherTag) && string(raw[:len(cipherTag)]) == cipherTag {
		pt, _ := b.open(raw)
		return pt
	}
	// 旧格式：钥匙串引用 id
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
