//go:build darwin

package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"errors"
	"os/exec"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

// Mac：Electron/Chromium OSCrypt —— Keychain 项 “Safe Storage”，口令经 PBKDF2 得 AES-128 钥；
// 密文前缀 "v10"，IV 为 16 个空格（Chromium 旧默认）。
type macSafeStorage struct {
	key []byte
}

func NewElectronSafeStorage() ElectronSafeStorage {
	s := &macSafeStorage{}
	if k, err := macKeychainPassword(); err == nil {
		s.key = pbkdf2.Key([]byte(k), []byte("saltysalt"), 1003, 16, sha1.New)
	}
	return s
}

func (s *macSafeStorage) Available() bool { return len(s.key) == 16 }

func (s *macSafeStorage) Decrypt(cipherText []byte) (string, bool) {
	if !s.Available() || len(cipherText) < 3+aes.BlockSize {
		return "", false
	}
	if string(cipherText[:3]) != "v10" {
		return "", false
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", false
	}
	iv := []byte("                ") // 16 spaces
	data := cipherText[3:]
	if len(data)%aes.BlockSize != 0 {
		return "", false
	}
	out := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
	plain, err := pkcs7Unpad(out)
	if err != nil {
		return "", false
	}
	return string(plain), true
}

func macKeychainPassword() (string, error) {
	// Electron app.getName() == @nomi-ai/electron → Keychain service/account 与之相关
	for _, service := range []string{
		"@nomi-ai/electron Safe Storage",
		"Nomi Safe Storage",
		"Electron Safe Storage",
		"Chromium Safe Storage",
	} {
		out, err := exec.Command("security", "find-generic-password", "-w", "-s", service).Output()
		if err == nil {
			return strings.TrimSpace(string(out)), nil
		}
	}
	return "", errors.New("no Safe Storage keychain item")
}

func pkcs7Unpad(b []byte) ([]byte, error) {
	if len(b) == 0 {
		return nil, errors.New("empty")
	}
	n := int(b[len(b)-1])
	if n == 0 || n > len(b) || n > aes.BlockSize {
		return nil, errors.New("bad padding")
	}
	for i := 0; i < n; i++ {
		if b[len(b)-1-i] != byte(n) {
			return nil, errors.New("bad padding")
		}
	}
	return b[:len(b)-n], nil
}
