package mediahandlers

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type fakeGW struct{}

func (fakeGW) Credentials(id string) *u.Obj {
	if id != "p1" {
		return nil
	}
	return u.NewObj("id", "p1", "name", "P", "baseURL", "https://x/v1", "apiKey", "sk")
}
func (fakeGW) ListOpenAiCompatible() []any {
	return []any{u.NewObj("id", "p1", "name", "P", "baseURL", "https://x/v1")}
}

func TestGatewayAdapters(t *testing.T) {
	g := func() GatewayLike { return fakeGW{} }
	ps := GatewayProviders(g)()
	if len(ps) != 1 || ps[0].ID != "p1" || ps[0].BaseURL != "https://x/v1" || ps[0].Name != "P" {
		t.Fatalf("%+v", ps)
	}
	c := GatewayCredentials(g)("p1")
	if c == nil || c.APIKey != "sk" || c.BaseURL != "https://x/v1" {
		t.Fatalf("%+v", c)
	}
	if GatewayCredentials(g)("nope") != nil {
		t.Fatal("unknown id")
	}
	nilG := func() GatewayLike { return nil }
	if p := GatewayProviders(nilG)(); p == nil || len(p) != 0 {
		t.Fatal("nil gateway => []")
	}
	if GatewayCredentials(nilG)("p1") != nil {
		t.Fatal("nil gateway => null")
	}
	// 真实 gwstore.Service 满足接口（空 store）
	var _ GatewayLike = gwstore.NewServiceForUserData(filepath.Join(t.TempDir()), nil, nil)
}
