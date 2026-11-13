package accounts

import (
	"slices"
	"testing"
)

func TestParseLoginOutput(t *testing.T) {
	for _, tt := range []struct {
		name, output, url, code string
		needsCode               bool
	}{
		{
			name: "grok device auth retains complete query",
			output: "To sign in, open this URL in your browser:\n\n" +
				"  https://accounts.x.ai/oauth2/device?user_code=ABCD-12345&state=test%2Bstate\n\n" +
				"Confirm this code in your browser:\n\n  ABCD-12345\n\n" +
				"\x1b[90mOnly continue with a code you requested.\x1b[0m\nWaiting for authorization...\n",
			url:  "https://accounts.x.ai/oauth2/device?user_code=ABCD-12345&state=test%2Bstate",
			code: "ABCD-12345",
		},
		{
			name:   "codex device auth",
			output: "https://auth.openai.com/codex/device\nYour one-time code:\n\nTEST-CODE1\n",
			url:    "https://auth.openai.com/codex/device",
			code:   "TEST-CODE1",
		},
		{
			name:   "grok browser oauth retains redirect and state",
			output: "Open this URL:\nhttps://accounts.x.ai/oauth2/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&state=test%2Bstate\n",
			url:    "https://accounts.x.ai/oauth2/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&state=test%2Bstate",
		},
		{
			name:      "claude paste code",
			output:    "\x1b[36mhttps://claude.ai/oauth/authorize?state=test\x1b[0m\nPaste code here:",
			url:       "https://claude.ai/oauth/authorize?state=test",
			needsCode: true,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseLoginOutput(tt.output)
			if got.Get("url") != tt.url {
				t.Fatalf("url = %v, want %q", got.Get("url"), tt.url)
			}
			if tt.code != "" && got.Get("code") != tt.code {
				t.Fatalf("code = %v, want %q", got.Get("code"), tt.code)
			}
			if tt.code == "" && got.Has("code") {
				t.Fatalf("unexpected code = %v", got.Get("code"))
			}
			if got.Get("needsCode") != tt.needsCode {
				t.Fatalf("needsCode = %v, want %v", got.Get("needsCode"), tt.needsCode)
			}
			if !IsLoginURL(tt.url) {
				t.Fatal("official sign-in URL rejected")
			}
		})
	}
}

func TestGrokLoginUsesBrowserOAuth(t *testing.T) {
	if args := LoginArgs("grok"); !slices.Equal(args, []string{"login", "--oauth"}) {
		t.Fatalf("Grok login args = %v, want browser OAuth instead of forced device auth", args)
	}
}
