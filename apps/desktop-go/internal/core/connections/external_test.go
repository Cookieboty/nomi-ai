package connections

// 对应 tests/unit/tasks/external.test.ts 的「能力目录」与「GitHub 对外写」两段

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func ghGrant(caps []string, repos ...string) []Grant {
	if repos == nil {
		repos = []string{"o/r"}
	}
	return []Grant{{ConnectionID: "conn_1", Capabilities: caps, Resources: repos}}
}

func wantMsg(t *testing.T, got, sub string) {
	t.Helper()
	if sub == "" && got != "" || sub != "" && !strings.Contains(got, sub) {
		t.Fatalf("got %q want %q", got, sub)
	}
}

func TestCatalogValidate(t *testing.T) {
	wantMsg(t, ValidateConnectionGrants(ghGrant([]string{"github.read"}), 1, nil), "")
	wantMsg(t, ValidateConnectionGrants(ghGrant([]string{"github.comment"}), 3, nil), "level 4")
	wantMsg(t, ValidateConnectionGrants(ghGrant([]string{"github.comment"}), 4, nil), "")
	wantMsg(t, ValidateConnectionGrants(ghGrant([]string{"github.merge"}), 4, nil), "never")
	wantMsg(t, ValidateConnectionGrants(ghGrant([]string{"github.write"}), 4, nil), "unknown")
	wantMsg(t, ValidateConnectionGrants(ghGrant([]string{"github.read"}, "o/*"), 4, nil), "wildcard")
	wantMsg(t, ValidateConnectionGrants([]Grant{{ConnectionID: "conn_1", Capabilities: []string{"github.read"}, Resources: []string{}}}, 4, nil), "no resources")
	wantMsg(t, ValidateConnectionGrants([]Grant{{ConnectionID: "conn_1", Capabilities: []string{"mcp.read"}, Resources: []string{"x"}}}, 4, nil), "does not apply")

	info := func(_ string, tool string) *McpToolInfo {
		switch tool {
		case "send":
			return &McpToolInfo{}
		case "r":
			return &McpToolInfo{ReadOnly: true, Remote: true}
		}
		return &McpToolInfo{ReadOnly: true}
	}
	g := func(caps []string, tools ...string) []Grant {
		return []Grant{{ConnectionID: "mcp:mail", Capabilities: caps, Resources: tools}}
	}
	wantMsg(t, ValidateConnectionGrants(g([]string{"mcp.read"}, "list"), 1, info), "")
	wantMsg(t, ValidateConnectionGrants(g([]string{"mcp.read"}, "send"), 4, info), "not read-only")
	wantMsg(t, ValidateConnectionGrants(g([]string{"mcp.call"}, "send"), 3, info), "level 4")
	wantMsg(t, ValidateConnectionGrants(g([]string{"mcp.call", "mcp.read"}, "send", "list"), 4, info), "")
	wantMsg(t, ValidateConnectionGrants(g([]string{"mcp.read"}, "r"), 1, info), "remote")

	grants := g([]string{"mcp.read"}, "list")
	for _, c := range []struct {
		server, tool string
		ro           bool
		want         string
	}{{"mail", "list", true, "read"}, {"mail", "list", false, ""}, {"mail", "send", false, ""}, {"cal", "list", true, ""}} {
		if got := McpGranted(grants, c.server, c.tool, c.ro); got != c.want {
			t.Fatalf("%+v: %q", c, got)
		}
	}
	if s, tool, ok := SplitMcpTool("mail__send"); !ok || s != "mail" || tool != "send" {
		t.Fatal(s, tool, ok)
	}
	if _, _, ok := SplitMcpTool("fs_read_text"); ok {
		t.Fatal("split")
	}
}

// 与 Node 的 contentHash 同样输入同样输出（node -e 算出的期望值）
func TestContentHashMatchesNode(t *testing.T) {
	h := ContentHash("github.comment", u.NewObj("connectionId", "conn_1", "repo", "o/r", "number", 3),
		u.NewObj("body", "hi <b> &   é"))
	if h != "b8cbdf06d89bc4d432d0b02092628343" {
		t.Fatal(h)
	}
	p, _ := u.ParseString(`{"to":"a@b","n":1.5,"z":[1,{"y":null}]}`)
	if h := ContentHash("mcp.call", u.NewObj("server", "mail", "tool", "send"), p); h != "9b67e4319d99c7ddaeee90476f59ff58" {
		t.Fatal(h)
	}
}

// fakeJournal：记下 intent / done / failed / open 的顺序
type fakeJournal struct {
	mu  sync.Mutex
	log []string
}

func (j *fakeJournal) Run(a ExternalAction, fn func(key string) (any, string, error)) (any, error) {
	j.mu.Lock()
	j.log = append(j.log, "intent:"+a.Action)
	j.mu.Unlock()
	v, ext, err := fn("t:a:1")
	j.mu.Lock()
	defer j.mu.Unlock()
	if err != nil {
		var na *ExternalNotAppliedError
		if errors.As(err, &na) {
			j.log = append(j.log, "failed")
		} else {
			j.log = append(j.log, "open")
		}
		return nil, err
	}
	j.log = append(j.log, "done:"+ext)
	return v, nil
}

func writeHarness(t *testing.T, api func(args []string) ([]byte, int)) (*Service, *[][]string, string) {
	calls := [][]string{}
	var mu sync.Mutex
	s := New(Deps{File: filepath.Join(t.TempDir(), "connections.json"), Secrets: fakeBox{}, Now: func() int64 { return 0 },
		RunGh: func(_ context.Context, args []string) ([]byte, int) {
			mu.Lock()
			calls = append(calls, args)
			mu.Unlock()
			if args[0] == "auth" {
				return authJSON("octo"), 0
			}
			return api(args)
		}})
	s.gap = 0
	c, err := s.AddGithub(context.Background(), AddInput{Mode: "gh"})
	if err != nil {
		t.Fatal(err)
	}
	return s, &calls, c.ID
}

func strp(s string) *string { return &s }

func TestGithubWriteGh(t *testing.T) {
	s, calls, id := writeHarness(t, func([]string) ([]byte, int) { return []byte(`{"id":5,"html_url":"u"}`), 0 })
	ctx := context.Background()
	j := &fakeJournal{}
	grant := []Grant{{ConnectionID: id, Capabilities: []string{"github.comment"}, Resources: []string{"o/r"}}}
	r, err := s.GithubWrite(ctx, "github.comment", GithubWriteParams{Repo: "o/r", Number: 3, Body: strp("hi")}, grant, j)
	if err != nil || u.Stringify(r) != `{"id":5,"url":"u"}` {
		t.Fatal(r, err)
	}
	args := (*calls)[len(*calls)-1]
	if strings.Join(args[:7], " ") != "api --method POST --include --hostname github.com /repos/o/r/issues/3/comments" ||
		args[len(args)-2] != "--raw-field" || args[len(args)-1] != "body=hi\n\n"+MarkerOf("t:a:1") {
		t.Fatalf("%q", args)
	}
	if strings.Join(j.log, ",") != "intent:github.comment,done:5" {
		t.Fatal(j.log)
	}
	code := func(err error) string {
		var e *Error
		if errors.As(err, &e) {
			return e.Code
		}
		return ""
	}
	if _, err := s.GithubWrite(ctx, "github.comment", GithubWriteParams{Repo: "x/y", Number: 3, Body: strp("hi")}, grant, j); code(err) != "not_allowed" {
		t.Fatal(err)
	}
	if _, err := s.GithubWrite(ctx, "github.pr.create", GithubWriteParams{Repo: "o/r", Head: "main", Base: "main", Title: "t"}, grant, j); code(err) != "bad_params" {
		t.Fatal(err)
	}
	// 后台没有副作用日志不写
	if _, err := s.GithubWrite(ctx, "github.comment", GithubWriteParams{Repo: "o/r", Number: 3, Body: strp("hi")}, grant, nil); code(err) != "not_allowed" {
		t.Fatal(err)
	}
	for _, a := range *calls {
		if strings.Join(a, " ") == "auth token" {
			t.Fatal("read the token")
		}
	}
}

func TestGithubWriteDefiniteVsUncertain(t *testing.T) {
	reply, code := "HTTP/2.0 422 Unprocessable Entity\r\nContent-Type: application/json\r\n\r\n"+`{"message":"Validation Failed"}`, 1
	s, _, id := writeHarness(t, func([]string) ([]byte, int) { return []byte(reply), code })
	grant := []Grant{{ConnectionID: id, Capabilities: []string{"github.comment"}, Resources: []string{"o/r"}}}
	j := &fakeJournal{}
	p := GithubWriteParams{Repo: "o/r", Number: 3, Body: strp("x")}
	if _, err := s.GithubWrite(context.Background(), "github.comment", p, grant, j); err == nil || !strings.Contains(err.Error(), "Validation Failed") {
		t.Fatal(err)
	}
	reply = ""
	if _, err := s.GithubWrite(context.Background(), "github.comment", p, grant, j); err == nil {
		t.Fatal("want error")
	}
	// 5xx 带错误正文也不确定（可能已经发出去了）
	reply = "HTTP/2.0 502 Bad Gateway\n\n" + `{"message":"x"}`
	if _, err := s.GithubWrite(context.Background(), "github.comment", p, grant, j); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatal(err)
	}
	if strings.Join(j.log, ",") != "intent:github.comment,failed,intent:github.comment,open,intent:github.comment,open" {
		t.Fatal(j.log)
	}
	bad := GithubWriteParams{Repo: "../x", Number: 3, Body: strp("x")}
	if _, err := s.GithubWrite(context.Background(), "github.comment", bad, grant, j); err == nil {
		t.Fatal("want bad_params")
	}
	if IsRepo("../x") || IsRepo("o/..") || !IsRepo("o/r.js") {
		t.Fatal("IsRepo")
	}
}

func TestGithubWriteToken(t *testing.T) {
	var gotBody, gotMethod string
	status := 201
	s := New(Deps{File: filepath.Join(t.TempDir(), "c.json"), Secrets: fakeBox{}, Now: func() int64 { return 0 },
		HTTP: func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Path, "/user") {
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewBufferString(`{"login":"tok"}`))}, nil
			}
			b, _ := io.ReadAll(r.Body)
			gotBody, gotMethod = string(b), r.Method
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(bytes.NewBufferString(`{"number":7,"html_url":"p"}`))}, nil
		}})
	s.gap = 0
	c, err := s.AddGithub(context.Background(), AddInput{Mode: "token", Token: "good"})
	if err != nil {
		t.Fatal(err)
	}
	draft := true
	p := GithubWriteParams{Repo: "o/r", Head: "nomi/fix", Base: "main", Title: "t", Draft: &draft}
	r, err := s.GithubWrite(context.Background(), "github.pr.create", p, nil, nil)
	if err != nil || u.Stringify(r) != `{"number":7,"url":"p"}` || gotMethod != "POST" ||
		gotBody != `{"title":"t","head":"nomi/fix","base":"main","body":"","draft":true}` {
		t.Fatal(r, err, gotMethod, gotBody)
	}
	_ = c
	// GitHub 明确拒绝：确定没生效（ExternalNotAppliedError）；5xx：不确定
	status = 422
	var na *ExternalNotAppliedError
	if _, err := s.GithubWrite(context.Background(), "github.pr.create", p, nil, nil); !errors.As(err, &na) {
		t.Fatal(err)
	}
	var we *GithubWriteError
	status = 503
	if _, err := s.GithubWrite(context.Background(), "github.pr.create", p, nil, nil); !errors.As(err, &we) || we.Definite {
		t.Fatal(err)
	}
}

func TestGithubReconcile(t *testing.T) {
	list := `[]`
	s, calls, id := writeHarness(t, func([]string) ([]byte, int) { return []byte(list), 0 })
	ctx := context.Background()
	target := u.NewObj("connectionId", id, "repo", "o/r", "number", 3)
	if r := s.GithubReconcile(ctx, "github.comment", 1_800_000_000_000, "t:a:1", target); r == nil || r.Applied {
		t.Fatal(r)
	}
	list = `[{"id":11,"body":"x\n\n` + MarkerOf("t:a:1") + `"}]`
	if r := s.GithubReconcile(ctx, "github.comment", 1_800_000_000_000, "t:a:1", target); r == nil || !r.Applied || r.ExternalID != "11" {
		t.Fatal(r)
	}
	last := (*calls)[len(*calls)-1]
	if p := last[len(last)-1]; !strings.HasPrefix(p, "/repos/o/r/issues/3/comments?") || !strings.Contains(p, "since=") {
		t.Fatal(p)
	}
	list = `[]`
	if r := s.GithubReconcile(ctx, "github.pr.create", 0, "t:a:1", u.NewObj("connectionId", id, "repo", "o/r", "head", "nomi/x")); r == nil || r.Applied {
		t.Fatal(r)
	}
	last = (*calls)[len(*calls)-1]
	if p := last[len(last)-1]; !strings.Contains(p, "head=o%3Anomi%2Fx") {
		t.Fatal(p)
	}
	if r := s.GithubReconcile(ctx, "github.comment", 0, "t:a:1", u.NewObj("connectionId", "nope")); r != nil {
		t.Fatal(r)
	}
	// 日志里的仓库不合法：按查不了处理，不拼路径
	if r := s.GithubReconcile(ctx, "github.comment", 0, "t:a:1", u.NewObj("connectionId", id, "repo", "o/r/x", "number", 3)); r != nil {
		t.Fatal(r)
	}
}

func TestGhWriteArgs(t *testing.T) {
	got := GhWriteArgs("h", WriteRequest{Method: "POST", Path: "/p", Fields: u.NewObj("title", "@x", "draft", true)})
	if strings.Join(got, "|") != "api|--method|POST|--include|--hostname|h|/p|--raw-field|title=@x|-F|draft=true" {
		t.Fatal(got)
	}
}

// 工具：前台每次确认（拒绝 = user_denied）；后台没有授权里的仓库拒绝
func TestWriteToolsConfirm(t *testing.T) {
	s, _, id := writeHarness(t, func([]string) ([]byte, int) { return []byte(`{"id":1}`), 0 })
	confirmed := []string{}
	allow := false
	var bgGrant []Grant
	background := false
	defs := s.Tools(ToolDeps{
		GrantOf:    func(context.Context) ([]Grant, bool) { return bgGrant, background },
		MarkRead:   func(context.Context) {},
		ExternalOf: func(context.Context) ExternalJournal { return &fakeJournal{} },
		Confirm: func(_ context.Context, r ConfirmRequest) bool {
			confirmed = append(confirmed, r.Tool+":"+r.Preview)
			return allow
		},
	})
	var comment func(context.Context, any) any
	for _, d := range defs {
		if d.Name == "github_comment" {
			d := d
			comment = func(ctx context.Context, in any) any { v, _ := d.Execute(ctx, in, tools.ExecContext{}); return v }
		}
	}
	in := u.NewObj("repo", "o/r", "number", 3, "body", "hi")
	if v := u.Stringify(comment(context.Background(), in)); !strings.Contains(v, "user_denied") {
		t.Fatal(v)
	}
	allow = true
	if v := u.Stringify(comment(context.Background(), in)); !strings.Contains(v, `"ok":true`) {
		t.Fatal(v)
	}
	if len(confirmed) != 2 || confirmed[0] != "github_comment:hi" {
		t.Fatal(confirmed)
	}
	background, bgGrant = true, []Grant{{ConnectionID: id, Capabilities: []string{"github.comment"}, Resources: []string{"x/y"}}}
	if v := u.Stringify(comment(context.Background(), in)); !strings.Contains(v, "not_allowed") || len(confirmed) != 2 {
		t.Fatal(v, confirmed)
	}
}
