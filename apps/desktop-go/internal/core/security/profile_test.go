package security_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/zalando/go-keyring"
)

func TestProfileKeyringIsolation(t *testing.T) {
	security.UseMockKeyring()
	productionKey := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("p", 32)))
	if err := keyring.Set("Nomi", "safe-storage-key", productionKey); err != nil {
		t.Fatal(err)
	}
	if err := keyring.Set("Nomi", "legacy:1", "production-secret"); err != nil {
		t.Fatal(err)
	}
	box := security.NewSecretBox("profile-test")
	encrypted, err := box.Encrypt("profile-secret", "unavailable")
	if err != nil {
		t.Fatal(err)
	}
	if got := security.NewSecretBox("restart").Decrypt(encrypted); got != "profile-secret" {
		t.Fatalf("restart decrypt = %q", got)
	}
	current, err := keyring.Get(hostports.GoProductName, "safe-storage-key")
	if err != nil {
		t.Fatal(err)
	}
	if hostports.Development && current == productionKey {
		t.Fatal("dev reused production master key")
	}
	if got, err := keyring.Get("Nomi", "safe-storage-key"); err != nil || got != productionKey {
		t.Fatal("production master key changed")
	}
	legacy := "enc:" + base64.StdEncoding.EncodeToString([]byte("legacy:1"))
	want := "production-secret"
	if hostports.Development {
		want = ""
	}
	if got := box.Decrypt(legacy); got != want {
		t.Fatalf("legacy decrypt = %q", got)
	}
}
