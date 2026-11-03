package providerlink

// 与 TS 跑同一份用例：apps/desktop-electron/internal/core/tests/fixtures/provider-link-cases.json
// （期望值由 TS 生成：UPDATE_PROVIDER_LINK_CASES=1 pnpm exec jest providerLink）

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type cases struct {
	Links []struct {
		Name   string `json:"name"`
		URL    string `json:"url"`
		Expect any    `json:"expect"`
	} `json:"links"`
	Manifests []struct {
		Name     string `json:"name"`
		Issuer   string `json:"issuer"`
		Manifest any    `json:"manifest"`
		Expect   any    `json:"expect"`
	} `json:"manifests"`
	Tokens []struct {
		Name     string `json:"name"`
		Issuer   string `json:"issuer"`
		Manifest any    `json:"manifest"`
		Token    any    `json:"token"`
		Expect   any    `json:"expect"`
	} `json:"tokens"`
	Authorize []struct {
		Endpoint  string `json:"endpoint"`
		State     string `json:"state"`
		Challenge string `json:"challenge"`
		Expect    any    `json:"expect"`
	} `json:"authorize"`
	PKCE []struct {
		Verifier string `json:"verifier"`
		Expect   any    `json:"expect"`
	} `json:"pkce"`
	Body []struct {
		Code     string `json:"code"`
		Verifier string `json:"verifier"`
		Expect   any    `json:"expect"`
	} `json:"body"`
	Mask []struct {
		Key    string `json:"key"`
		Expect any    `json:"expect"`
	} `json:"mask"`
	SameURL []struct {
		A      string `json:"a"`
		B      string `json:"b"`
		Expect any    `json:"expect"`
	} `json:"sameUrl"`
}

func load(t *testing.T) cases {
	t.Helper()
	b, err := os.ReadFile(paritytest.RepoPath("apps", "desktop-electron", "internal", "core", "tests", "fixtures", "provider-link-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c cases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// plain：走一遍 JSON，与用例里的期望值同形
func plain(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func eq(t *testing.T, name string, got, want any) {
	t.Helper()
	g := plain(t, got)
	if !reflect.DeepEqual(g, want) {
		gb, _ := json.Marshal(g)
		wb, _ := json.Marshal(want)
		t.Errorf("%s:\n got  %s\n want %s", name, gb, wb)
	}
}

func TestParityCases(t *testing.T) {
	c := load(t)
	for _, x := range c.Links {
		eq(t, "link: "+x.Name, ParseLink(x.URL), x.Expect)
	}
	for _, x := range c.Manifests {
		eq(t, "manifest: "+x.Name, ParseManifest(x.Manifest, x.Issuer), x.Expect)
	}
	for _, x := range c.Tokens {
		m := ParseManifest(x.Manifest, x.Issuer)
		if !m.OK {
			t.Fatalf("token %s: fixture manifest invalid: %s", x.Name, m.Code)
		}
		eq(t, "token: "+x.Name, ParseTokenResponse(x.Token, *m.Value), x.Expect)
	}
	for _, x := range c.Authorize {
		eq(t, "authorize", AuthorizeURL(Manifest{AuthorizationEndpoint: x.Endpoint}, x.State, x.Challenge), x.Expect)
	}
	for _, x := range c.PKCE {
		eq(t, "pkce", PKCEChallenge(x.Verifier), x.Expect)
	}
	for _, x := range c.Body {
		eq(t, "body", TokenRequestBody(x.Code, x.Verifier), x.Expect)
	}
	for _, x := range c.Mask {
		eq(t, "mask", MaskKey(x.Key), x.Expect)
	}
	for _, x := range c.SameURL {
		eq(t, "sameUrl "+x.A+" "+x.B, SameURL(x.A, x.B), x.Expect)
	}
}
