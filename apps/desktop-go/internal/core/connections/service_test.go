package connections

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeBox struct{}

func (fakeBox) CanEncrypt() bool { return true }
func (fakeBox) Encrypt(v, _ string) (string, error) {
	return "enc:" + strings.ToUpper(fmt.Sprintf("%x", v)), nil
}
func (fakeBox) Decrypt(v string) string {
	var b []byte
	fmt.Sscanf(strings.ToLower(strings.TrimPrefix(v, "enc:")), "%x", &b)
	return string(b)
}

func authJSON(login string) []byte {
	return []byte(fmt.Sprintf(`{"hosts":{"github.com":[{"active":true,"host":"github.com","login":%q,"scopes":"gist, read:org, repo, workflow","state":"success","tokenSource":"keyring"}]}}`, login))
}

func harness(t *testing.T, login *string, installed bool) (*Service, *[][]string, string) {
	dir := t.TempDir()
	calls := [][]string{}
	s := New(Deps{File: filepath.Join(dir, "connections.json"), Secrets: fakeBox{}, Now: func() int64 { return 1 },
		RunGh: func(_ context.Context, args []string) ([]byte, int) {
			calls = append(calls, args)
			if !installed {
				return nil, 127
			}
			if args[0] == "auth" {
				if login == nil {
					return []byte(`{"hosts":{}}`), 0
				}
				return authJSON(*login), 0
			}
			p := args[len(args)-1]
			if strings.HasPrefix(p, "/notifications") {
				return []byte(`[{"id":"1","repository":{"full_name":"o/r"}},{"id":"2","repository":{"full_name":"x/y"}}]`), 0
			}
			b, _ := json.Marshal(map[string]string{"path": p})
			return b, 0
		},
		HTTP: func(r *http.Request) (*http.Response, error) {
			ok := r.Header.Get("Authorization") == "Bearer good"
			code := 401
			body := `{}`
			if ok {
				code = 200
				body = `{"login":"tok-user"}`
				if !strings.HasSuffix(r.URL.Path, "/user") {
					body = fmt.Sprintf(`{"url":%q}`, r.URL.String())
				}
			}
			return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(bytes.NewBufferString(body))}, nil
		}})
	return s, &calls, dir
}

func sp(s string) *string { return &s }

func TestParseAndTemplates(t *testing.T) {
	a := ParseAuthStatus(authJSON("octo"))
	if len(a) != 1 || a[0].Login != "octo" || strings.Join(WideScopes(a[0].Scopes), ",") != "repo,workflow" {
		t.Fatalf("%+v", a)
	}
	if p, q, err := BuildReadRequest(ReadParams{Endpoint: "issues", Repo: sp("o/r"), State: sp("open")}); err != nil || p != "/repos/o/r/issues" || q.Get("state") != "open" {
		t.Fatal(p, q, err)
	}
	for _, bad := range []ReadParams{{Endpoint: "repo", Repo: sp("../../user")}, {Endpoint: "repo", Repo: sp("o/r?x=1")},
		{Endpoint: "issues", Repo: sp("o/r"), Since: sp("yesterday")}, {Endpoint: "check_runs", Repo: sp("o/r"), Ref: sp("a b")}} {
		if _, _, err := BuildReadRequest(bad); err == nil {
			t.Fatalf("want error for %+v", bad)
		}
	}
	env := strings.Join(GhEnv([]string{"PATH=/bin", "HOME=/h", "GH_TOKEN=x", "GITHUB_TOKEN=y", "SECRET=z"}), ";")
	if env != "PATH=/bin;HOME=/h;GH_PROMPT_DISABLED=1;GH_NO_UPDATE_NOTIFIER=1;NO_COLOR=1" {
		t.Fatal(env)
	}
}

func TestAddReadCheck(t *testing.T) {
	login := "octo"
	s, calls, _ := harness(t, &login, true)
	c, err := s.AddGithub(context.Background(), AddInput{Mode: "gh"})
	if err != nil || c.Auth.Kind != "cli-login" || strings.Join(c.WideScopes, ",") != "repo,workflow" {
		t.Fatal(c, err)
	}
	for _, a := range *calls {
		if strings.Join(a, " ") == "auth token" {
			t.Fatal("read the token")
		}
	}
	if v, err := s.GithubRead(context.Background(), ReadParams{Endpoint: "repo", Repo: sp("any/repo")}, nil); err != nil || v.(map[string]any)["path"] != "/repos/any/repo" {
		t.Fatal(v, err)
	}
	grant := []Grant{{ConnectionID: c.ID, Capabilities: []string{"github.read"}, Resources: []string{"o/r"}}}
	if _, err := s.GithubRead(context.Background(), ReadParams{Endpoint: "issues", Repo: sp("x/y")}, grant); err == nil || err.(*Error).Code != "not_allowed" {
		t.Fatal(err)
	}
	if v, err := s.GithubRead(context.Background(), ReadParams{Endpoint: "notifications"}, grant); err != nil || len(v.([]any)) != 1 {
		t.Fatal(v, err)
	}
	if _, err := s.GithubRead(context.Background(), ReadParams{Endpoint: "issues", Repo: sp("o/r")}, []Grant{}); err == nil || err.(*Error).Code != "not_found" {
		t.Fatal(err)
	}
	login = "someone-else"
	if c2, _ := s.Check(context.Background(), c.ID); c2.Status != "needs_login" {
		t.Fatal(c2.Status)
	}
	login = "octo"
	if c2, _ := s.Check(context.Background(), c.ID); c2.Status != "ok" {
		t.Fatal(c2.Status)
	}
}

func TestAddErrorsAndToken(t *testing.T) {
	if _, err := func() (*Connection, error) {
		s, _, _ := harness(t, nil, false)
		return s.AddGithub(context.Background(), AddInput{Mode: "gh"})
	}(); err == nil || err.(*Error).Code != "unavailable" {
		t.Fatal(err)
	}
	s, _, dir := harness(t, nil, true)
	if _, err := s.AddGithub(context.Background(), AddInput{Mode: "gh"}); err == nil || err.(*Error).Code != "needs_login" {
		t.Fatal(err)
	}
	if _, err := s.AddGithub(context.Background(), AddInput{Mode: "token", Token: "bad"}); err == nil || err.(*Error).Code != "needs_login" {
		t.Fatal(err)
	}
	c, err := s.AddGithub(context.Background(), AddInput{Mode: "token", Token: " good "})
	if err != nil || c.Account.Login != "tok-user" {
		t.Fatal(c, err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "connections.json"))
	listed, _ := json.Marshal(s.List())
	if strings.Contains(string(raw), `"good"`) || !strings.Contains(string(raw), "enc:") || strings.Contains(string(listed), "secret") {
		t.Fatal(string(raw), string(listed))
	}
	if v, err := s.GithubRead(context.Background(), ReadParams{Endpoint: "repo", Repo: sp("o/r"), ConnectionID: &c.ID}, nil); err != nil ||
		v.(map[string]any)["url"] != "https://api.github.com/repos/o/r" {
		t.Fatal(v, err)
	}
	if !s.Remove(c.ID) {
		t.Fatal("remove")
	}
}
