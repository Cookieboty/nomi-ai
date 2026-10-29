package security_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

func TestMemoryBoxRoundTrip(t *testing.T) {
	b := security.NewMemoryBox()
	enc, err := b.Encrypt("sk-test", "no")
	if err != nil || !strings.HasPrefix(enc, "enc:") {
		t.Fatalf("%q %v", enc, err)
	}
	if b.Decrypt(enc) != "sk-test" {
		t.Fatal(b.Decrypt(enc))
	}
	if b.Decrypt("plain") != "plain" {
		t.Fatal("plaintext passthrough")
	}
}

func TestMockKeyring(t *testing.T) {
	security.UseMockKeyring()
	b := security.NewSecretBox("t")
	enc, err := b.Encrypt("secret", "no")
	if err != nil {
		t.Fatal(err)
	}
	if b.Decrypt(enc) != "secret" {
		t.Fatal(b.Decrypt(enc))
	}
}

// 修复前计数器每次启动从 0 开始，重启后的新值会覆盖旧值的钥匙串条目。
func TestSecretBoxSurvivesRestart(t *testing.T) {
	security.UseMockKeyring()
	a := security.NewSecretBox("extensions")
	e1, err := a.Encrypt("first", "x")
	if err != nil {
		t.Fatal(err)
	}
	b := security.NewSecretBox("extensions") // 模拟重启
	e2, err := b.Encrypt("second", "x")
	if err != nil {
		t.Fatal(err)
	}
	c := security.NewSecretBox("gateway")
	if e1 == e2 || c.Decrypt(e1) != "first" || c.Decrypt(e2) != "second" || b.Decrypt(e1) != "first" {
		t.Fatalf("lost secret: %q %q", c.Decrypt(e1), c.Decrypt(e2))
	}
	if e3, _ := b.Encrypt("first", "x"); e3 == e1 {
		t.Fatal("ciphertext must be randomized like safeStorage")
	}
	// 旧格式引用仍可读
	_ = security.KeyringSet("migrate:1", "legacy")
	if got := b.Decrypt("enc:" + base64.StdEncoding.EncodeToString([]byte("migrate:1"))); got != "legacy" {
		t.Fatal(got)
	}
}
