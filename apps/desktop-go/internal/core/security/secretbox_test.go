package security_test

import (
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
