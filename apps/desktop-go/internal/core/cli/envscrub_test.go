package cli

import (
	"slices"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestIsSecretEnv(t *testing.T) {
	secret := []string{
		"GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"STRIPE_API_KEY", "PGPASSWORD", "MYSQL_PWD", "DATABASE_URL", "PROD_DATABASE_URL", "SENTRY_DSN",
		"GITHUB_PAT", "SLACK_CLIENT_SECRET", "SIGNING_KEY", "DOCKER_PASSWORD", "GOOGLE_APPLICATION_CREDENTIALS",
	}
	plain := []string{
		"PATH", "HOME", "PWD", "OLDPWD", "LANG", "TERM", "SHELL", "TOKENIZERS_PARALLELISM", "SECURITYSESSIONID",
		"GIT_ASKPASS", "SSH_AUTH_SOCK", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "JAVA_HOME", "KEYCHAIN_PATH",
	}
	for _, n := range secret {
		if !IsSecretEnv(n) {
			t.Errorf("%s should count as a secret", n)
		}
	}
	for _, n := range plain {
		if IsSecretEnv(n) {
			t.Errorf("%s is not a secret", n)
		}
	}
}

func TestScrubSecretEnv(t *testing.T) {
	env := util.NewObj(
		"PATH", "/bin", "GITHUB_TOKEN", "g", "ANTHROPIC_API_KEY", "a", "OPENAI_API_KEY", "o", "NPM_TOKEN", "n",
		"AWS_SECRET_ACCESS_KEY", "s", "GOOGLE_API_KEY", "k", "OPENROUTER_API_KEY", "r",
	)
	out, dropped := ScrubSecretEnv(env, []string{"npm_token"})
	if !slices.Equal(out.Keys(), []string{"PATH", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NPM_TOKEN", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"}) {
		t.Fatalf("kept %v", out.Keys())
	}
	if !slices.Equal(dropped, []string{"GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"}) {
		t.Fatalf("dropped %v", dropped)
	}
	if env.Get("GITHUB_TOKEN") != "g" {
		t.Fatal("input must not be modified")
	}

	// Claude Code 走 Bedrock / Vertex 时云账号要留着
	bedrock := util.NewObj("CLAUDE_CODE_USE_BEDROCK", "1", "AWS_SECRET_ACCESS_KEY", "s", "GITHUB_TOKEN", "g")
	if out, _ := ScrubSecretEnv(bedrock, nil); !out.Has("AWS_SECRET_ACCESS_KEY") || out.Has("GITHUB_TOKEN") {
		t.Fatalf("bedrock env: %v", out.Keys())
	}
	vertex := util.NewObj("CLAUDE_CODE_USE_VERTEX", "true", "GOOGLE_APPLICATION_CREDENTIALS", "/k.json")
	if out, _ := ScrubSecretEnv(vertex, nil); !out.Has("GOOGLE_APPLICATION_CREDENTIALS") {
		t.Fatal("vertex credentials must stay")
	}
	off := util.NewObj("CLAUDE_CODE_USE_BEDROCK", "0", "AWS_SECRET_ACCESS_KEY", "s")
	if out, _ := ScrubSecretEnv(off, nil); out.Has("AWS_SECRET_ACCESS_KEY") {
		t.Fatal("bedrock switched off: AWS keys go")
	}
}
