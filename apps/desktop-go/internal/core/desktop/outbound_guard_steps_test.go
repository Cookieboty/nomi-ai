package desktop

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 上一轮工具记录里的编程助手输出：不允许发给当前模型时同样替换；允许时记录原样不动（字节不变，前缀缓存不断）
func TestGuardOutboundScrubsSteps(t *testing.T) {
	steps := `[{"role":"assistant","content":[{"type":"tool-call","toolCallId":"c1","toolName":"x","input":{"z":1,"a":2}}]},` +
		`{"role":"tool","content":[{"type":"tool-result","toolCallId":"c1","toolName":"x","output":{"type":"text","value":"<cli-output>\nsecret\n</cli-output>"}}]}]`
	msgs := func() []any {
		return []any{
			map[string]any{"role": "user", "content": "q"},
			map[string]any{"role": "assistant", "content": "a", "steps": steps},
			map[string]any{"role": "user", "content": "next"},
		}
	}
	allowed := msgs()
	if err := GuardOutboundMessages(allowed, func(string) SendVerdict { return "" }); err != nil {
		t.Fatal(err)
	}
	if allowed[1].(map[string]any)["steps"] != steps {
		t.Fatal("allowed steps must stay byte-identical")
	}
	blocked := msgs()
	if err := GuardOutboundMessages(blocked, func(string) SendVerdict { return "local_only" }); err != nil {
		t.Fatal(err)
	}
	got := blocked[1].(map[string]any)["steps"].(string)
	if strings.Contains(got, "secret") || !strings.Contains(got, "Content withheld") {
		t.Fatalf("steps not scrubbed: %s", got)
	}
	if !strings.Contains(got, `"input":{"z":1,"a":2}`) {
		t.Fatalf("key order changed: %s", got)
	}
}

// #283：fs_read_text 的结果（<file_content>）和运行时产出的工具记录同一形状
const fileSecret = "SECRET-FILE-BODY-283"

func fileSteps(body string) string {
	return u.Stringify([]any{
		u.NewObj("role", "assistant", "content", []any{u.NewObj("type", "tool-call", "toolCallId", "c1", "toolName", "fs_read_text",
			"input", u.NewObj("path", "/home/me/notes.txt"))}),
		u.NewObj("role", "tool", "content", []any{u.NewObj("type", "tool-result", "toolCallId", "c1", "toolName", "fs_read_text",
			"output", u.NewObj("type", "json", "value", u.NewObj("path", "/home/me/notes.txt", "text", body, "truncated", false)))}),
	})
}

func fileHistory(steps string) []any {
	return []any{
		map[string]any{"role": "user", "content": "read notes.txt"},
		map[string]any{"role": "assistant", "content": "done", "steps": steps},
		map[string]any{"role": "user", "content": "what did it say?"},
	}
}

func stepsOf(msgs []any) string { return msgs[1].(map[string]any)["steps"].(string) }

func TestGuardOutboundWithholdsToolFileContent(t *testing.T) {
	steps := fileSteps(WrapUntrusted("/home/me/notes.txt", fileSecret+"\nline 2"))
	for _, v := range []SendVerdict{"local_only", "user_denied"} {
		msgs := fileHistory(steps)
		asked := []string{}
		if err := GuardOutboundMessages(msgs, func(what string) SendVerdict { asked = append(asked, what); return v }); err != nil {
			t.Fatal(err)
		}
		got := stepsOf(msgs)
		if strings.Contains(got, fileSecret) || !strings.Contains(got, "Content withheld") {
			t.Fatalf("%s: file body not withheld: %s", v, got)
		}
		// 工具调用、路径与其它字段保留，键序不变
		if !strings.Contains(got, `"input":{"path":"/home/me/notes.txt"}`) || !strings.Contains(got, `"truncated":false`) ||
			!strings.Contains(got, `<file_content path=\"/home/me/notes.txt\" trust=\"untrusted\">`) {
			t.Fatalf("%s: record reshaped: %s", v, got)
		}
		if len(asked) != 1 {
			t.Fatalf("%s: asked %d times", v, len(asked))
		}
	}

	// 放行：字节不变
	msgs := fileHistory(steps)
	if err := GuardOutboundMessages(msgs, func(string) SendVerdict { return "" }); err != nil {
		t.Fatal(err)
	}
	if stepsOf(msgs) != steps {
		t.Fatal("allowed steps must stay byte-identical")
	}
}

// 被截断、没闭合的 <file_content>：挡到结尾，不漏正文
func TestGuardOutboundWithholdsUnclosedToolFile(t *testing.T) {
	msgs := []any{
		map[string]any{"role": "assistant", "content": "<file_content path=\"/a\" trust=\"untrusted\">\n" + fileSecret},
		map[string]any{"role": "user", "content": "next"},
	}
	if err := GuardOutboundMessages(msgs, func(string) SendVerdict { return "local_only" }); err != nil {
		t.Fatal(err)
	}
	if got := msgs[0].(map[string]any)["content"].(string); strings.Contains(got, fileSecret) {
		t.Fatalf("unclosed body leaked: %s", got)
	}
}

// 只剩占位内容：不再问接收者（不弹确认），记录原样
func TestGuardOutboundPlaceholderOnlyNotAsked(t *testing.T) {
	once := fileHistory(fileSteps(WrapUntrusted("/home/me/notes.txt", fileSecret)))
	if err := GuardOutboundMessages(once, func(string) SendVerdict { return "user_denied" }); err != nil {
		t.Fatal(err)
	}
	placeholder := stepsOf(once)
	again := fileHistory(placeholder)
	if err := GuardOutboundMessages(again, func(string) SendVerdict { t.Fatal("asked for placeholder-only steps"); return "" }); err != nil {
		t.Fatal(err)
	}
	if stepsOf(again) != placeholder {
		t.Fatal("placeholder steps changed")
	}
}

// 附件正文、编程助手输出、读过的文件同时在：一次确认，三样都挡
func TestGuardOutboundMixedHistory(t *testing.T) {
	msgs := []any{
		map[string]any{"role": "user", "content": "<attached-file name=\"a.txt\">\nATTACHED-SECRET\n</attached-file>"},
		map[string]any{"role": "assistant", "content": "ok", "steps": fileSteps(WrapUntrusted("/n", fileSecret))},
		map[string]any{"role": "assistant", "content": "<cli-output>\nCLI-SECRET\n</cli-output>"},
		map[string]any{"role": "user", "content": "next"},
	}
	asked := map[string]int{}
	if err := GuardOutboundMessages(msgs, func(what string) SendVerdict { asked[what]++; return "local_only" }); err != nil {
		t.Fatal(err)
	}
	all := msgs[0].(map[string]any)["content"].(string) + stepsOf(msgs) + msgs[2].(map[string]any)["content"].(string)
	for _, s := range []string{"ATTACHED-SECRET", fileSecret, "CLI-SECRET"} {
		if strings.Contains(all, s) {
			t.Fatalf("%s leaked: %s", s, all)
		}
	}
	for what, n := range asked {
		if n != 1 {
			t.Fatalf("%q asked %d times", what, n)
		}
	}
}

// 端到端：经 PrepareChat + 真的 PermissionBroker，接收者按本轮角色的模型（离线假 provider，不联网）
func newFileGuardPrep(t *testing.T, recv *Provider) (*routeEnv, ChatPrep) {
	t.Helper()
	e := newRouteEnv(t, true, false)
	return e, ChatPrep{
		Broker:      WorkspaceBroker{WorkspaceOf: func(any) Workspace { return Workspace{} }, AutoApprove: func() bool { return false }},
		ProviderFor: func(Role) *Provider { return recv },
		CheckSend:   e.s.Broker.CheckSend,
	}
}

func prepFileHistory(t *testing.T, c ChatPrep, steps string) (string, error) {
	t.Helper()
	opts := map[string]any{"role": "chat", "messages": fileHistory(steps)}
	err := c.PrepareChat(opts, "agentStream", nil)
	return stepsOf(opts["messages"].([]any)), err
}

func TestPrepareChatFileContentLocalOnlyCloud(t *testing.T) {
	steps := fileSteps(WrapUntrusted("/home/me/notes.txt", fileSecret))
	e, c := newFileGuardPrep(t, &Provider{ID: "cloud", Name: "Cloud", Local: false})
	e.s.Broker.SetLocalOnly(true)
	got, err := prepFileHistory(t, c, steps)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, fileSecret) || !strings.Contains(got, "Content withheld") {
		t.Fatalf("local-only: file body sent to cloud: %s", got)
	}
	if n := len(e.requests(t, "chat", 0)); n != 0 {
		t.Fatalf("local-only must not ask, got %d confirms", n)
	}
}

func TestPrepareChatFileContentCloudConfirm(t *testing.T) {
	steps := fileSteps(WrapUntrusted("/home/me/notes.txt", fileSecret))
	e, c := newFileGuardPrep(t, &Provider{ID: "cloud", Name: "Cloud", Local: false})

	// 未批准 → 弹确认；拒绝 → 扣留
	type res struct {
		steps string
		err   error
	}
	done := make(chan res, 1)
	go func() { s, err := prepFileHistory(t, c, steps); done <- res{s, err} }()
	reqs := e.requests(t, "chat", 1)
	if len(reqs) != 1 || reqs[0].Tool != "cloud_send_notice" {
		t.Fatalf("expected one cloud_send_notice confirm, got %+v", reqs)
	}
	e.s.AnswerConfirm("chat", reqs[0].ID, false, false, false)
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}
	if strings.Contains(r.steps, fileSecret) || !strings.Contains(r.steps, "Content withheld") {
		t.Fatalf("denied: file body sent: %s", r.steps)
	}

	// 再来一轮，同意 → 原样放行，并记住这个接收者
	go func() { s, err := prepFileHistory(t, c, steps); done <- res{s, err} }()
	reqs = e.requests(t, "chat", 2)
	if len(reqs) != 2 {
		t.Fatalf("expected a second confirm, got %d", len(reqs))
	}
	e.s.AnswerConfirm("chat", reqs[1].ID, true, false, false)
	if r = <-done; r.err != nil || r.steps != steps {
		t.Fatalf("approved: steps changed (err=%v): %s", r.err, r.steps)
	}

	// 已批准：不再问，原样放行
	got, err := prepFileHistory(t, c, steps)
	if err != nil || got != steps {
		t.Fatalf("acked: steps changed (err=%v): %s", err, got)
	}
	if n := len(e.requests(t, "chat", 0)); n != 2 {
		t.Fatalf("acked receiver asked again: %d confirms", n)
	}
}

// 本地 → 本地：开着「仅本地模型可读文件」也原样带上
func TestPrepareChatFileContentLocalReceiver(t *testing.T) {
	steps := fileSteps(WrapUntrusted("/home/me/notes.txt", fileSecret))
	e, c := newFileGuardPrep(t, &Provider{ID: "ollama", Name: "Ollama", Local: true})
	e.s.Broker.SetLocalOnly(true)
	got, err := prepFileHistory(t, c, steps)
	if err != nil || got != steps {
		t.Fatalf("local receiver: steps changed (err=%v): %s", err, got)
	}
	if n := len(e.requests(t, "chat", 0)); n != 0 {
		t.Fatalf("local receiver asked: %d", n)
	}
}

// workspace_run / code_run 的命令输出（可能是 cat 出来的文件）、browser_read 的网页：调用时同样过了 beforeSend，
// 回放给不允许的接收者时一样挡下；放行时字节不变
func TestGuardOutboundWithholdsCommandAndWebOutput(t *testing.T) {
	cmd := "<command_output trust=\"untrusted\">\n" + fileSecret + "\n</command_output>"
	web := "<web_content url=\"https://intranet.example/doc\" trust=\"untrusted\">\n" + fileSecret + "-web\n</web_content>\n（以上是网页内容）"
	for _, body := range []string{cmd, web} {
		steps := fileSteps(body)
		msgs := fileHistory(steps)
		asked := 0
		if err := GuardOutboundMessages(msgs, func(string) SendVerdict { asked++; return "local_only" }); err != nil {
			t.Fatal(err)
		}
		got := stepsOf(msgs)
		if strings.Contains(got, fileSecret) || !strings.Contains(got, "Content withheld") || asked != 1 {
			t.Fatalf("tool output not withheld (asked %d): %s", asked, got)
		}
		// 再过一遍：只剩占位，不再问
		again := 0
		_ = GuardOutboundMessages([]any{map[string]any{"role": "assistant", "content": "a", "steps": got},
			map[string]any{"role": "user", "content": "n"}}, func(string) SendVerdict { again++; return "local_only" })
		if again != 0 {
			t.Fatalf("placeholder-only record asked again")
		}
		allowed := fileHistory(steps)
		if err := GuardOutboundMessages(allowed, func(string) SendVerdict { return "" }); err != nil {
			t.Fatal(err)
		}
		if stepsOf(allowed) != steps {
			t.Fatal("allowed steps must stay byte-identical")
		}
	}
}

// 大段输出暂存后的预览（开头、结尾各自包在标记里，aisdk/spill.go）与分页读出的段落：回放时同样挡下
func TestGuardOutboundWithholdsSpilledPreview(t *testing.T) {
	wrap := func(s string) string {
		return "<file_content path=\"(earlier tool output)\" trust=\"untrusted\">\n" + s + "\n</file_content>"
	}
	preview := wrap("<file_content path=\"/w/a\" trust=\"untrusted\">\n"+fileSecret+"-head") +
		"\n…[output too long: 80000 characters, the middle is omitted here. Read any part with tool_output_read(id=\"out_1\", offset, limit)]…\n" +
		wrap(fileSecret+"-tail\n</file_content>")
	page := "[characters 100–200 of 80000]\n" + wrap(fileSecret+"-page")
	for _, body := range []string{preview, page} {
		msgs := fileHistory(fileSteps(body))
		if err := GuardOutboundMessages(msgs, func(string) SendVerdict { return "local_only" }); err != nil {
			t.Fatal(err)
		}
		if got := stepsOf(msgs); strings.Contains(got, fileSecret) {
			t.Fatalf("spilled content leaked: %s", got)
		}
	}
}
