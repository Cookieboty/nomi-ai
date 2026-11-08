package aisdk

// 本地数据（文件 / 命令输出 / 网页）再交给模型前按那一次的接收者重新检查（#287 分页读、#288 工具循环摘要）

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 假的外发检查：local 开头的接收者放行，其余按「仅本地模型可读文件」拒绝；记下每次查的是谁
func fakeDataSendCheck(t *testing.T) *[]string {
	t.Helper()
	var seen []string
	tools.SetDataSendCheck(func(_ context.Context, recv *tools.ToolCallProvider, roles ...string) error {
		who := strings.Join(roles, ",")
		if recv != nil {
			who = recv.ID
		}
		seen = append(seen, who)
		if strings.HasPrefix(who, "local") {
			return nil
		}
		return errors.New("local_only")
	})
	t.Cleanup(func() { tools.SetDataSendCheck(nil) })
	return &seen
}

// 本地模型读了大文件；同一对话换成云端模型后，用预览里的 id 分页读：拒绝，不返回正文。本地模型照常能读
func TestSpillReadRechecksReceiver(t *testing.T) {
	seen := fakeDataSendCheck(t)
	big := "<file_content path=\"/w/a.log\" trust=\"untrusted\">\n" + strings.Repeat("x", 40_000) + "SECRET" + strings.Repeat("y", 20_000) + "\n</file_content>"
	plain := strings.Repeat("z", 40_000) + "PLAIN" + strings.Repeat("z", 20_000)
	defs := []tools.Definition{
		{Name: "fs_read_text", Execute: func(context.Context, any, tools.ExecContext) (any, error) { return big, nil }},
		{Name: "list", Execute: func(context.Context, any, tools.ExecContext) (any, error) { return plain, nil }},
	}
	req := func() *llm.ChatRequest {
		return &llm.ChatRequest{Messages: []llm.ChatMessage{{Role: "user", Content: "q"}}, Extra: map[string]any{"conversationId": "c-recv"}}
	}
	idOf := func(s string) string {
		id := s[strings.Index(s, `id="`)+4:]
		return id[:strings.Index(id, `"`)]
	}
	local := (&Provider{ID: "local-llm", opts: Options{Receiver: &tools.ToolCallProvider{ID: "local-llm"}}}).toolsFor(defs, req())
	out, _ := toolByName(local, "fs_read_text").Execute(context.Background(), u.NewObj(), "t1")
	id := idOf(out.(string))
	at := float64(strings.Index(big, "SECRET"))
	if page, err := toolByName(local, OutputReadTool).Execute(context.Background(), u.NewObj("id", id, "offset", at, "limit", float64(50)), "t2"); err != nil || !strings.Contains(page.(string), "SECRET") {
		t.Fatalf("local receiver: %v %v", page, err)
	}
	cloud := (&Provider{ID: "cloud", opts: Options{Receiver: &tools.ToolCallProvider{ID: "cloud"}}}).toolsFor(defs, req())
	page, err := toolByName(cloud, OutputReadTool).Execute(context.Background(), u.NewObj("id", id, "offset", at, "limit", float64(50)), "t3")
	if err == nil || page != nil {
		t.Fatalf("cloud receiver must be refused: %v %v", page, err)
	}
	if got := (*seen)[len(*seen)-1]; got != "cloud" {
		t.Fatalf("checked %q, want the current receiver", got)
	}
	// 不带本地数据标记的输出不需要检查
	n := len(*seen)
	out2, _ := toolByName(cloud, "list").Execute(context.Background(), u.NewObj(), "t4")
	if p, err := toolByName(cloud, OutputReadTool).Execute(context.Background(), u.NewObj("id", idOf(out2.(string)), "offset", float64(40_000), "limit", float64(10)), "t5"); err != nil || !strings.Contains(p.(string), "PLAIN") || len(*seen) != n {
		t.Fatalf("plain output: %v %v", p, err)
	}
}

// 工具循环摘要：过程记录里有本地数据、摘要模型不允许读时，正文换成占位（截断剪掉闭合标记也挡得住）；允许时原样
func TestSummaryWithholdsLocalData(t *testing.T) {
	asst := func(id string) *u.Obj {
		return u.NewObj("role", "assistant", "content", []any{u.NewObj("type", "tool-call", "toolCallId", id, "toolName", "look", "input", u.NewObj())})
	}
	data := "<file_content path=\"/w/a.txt\" trust=\"untrusted\">\nSECRET" + strings.Repeat("s", 3000) + "\n</file_content>"
	step := []*u.Obj{u.NewObj("role", "user", "content", "do it")}
	for i := 0; i < 8; i++ {
		id := "s" + string(rune('a'+i))
		step = append(step, asst(id), toolMsg(id, data))
	}
	run := func(check func() error) string {
		var got string
		g := newContextGuard(100_000, "")
		g.turnBase, g.keep = 1, guardKeepRecent
		g.sendCheck = check
		g.summarize = func(_, transcript string) (string, error) { got = transcript; return "ok", nil }
		if !g.trySummarize(step) {
			t.Fatal("no summary")
		}
		return got
	}
	if tr := run(func() error { return errors.New("local_only") }); strings.Contains(tr, "SECRET") || !strings.Contains(tr, "Content withheld") || !strings.Contains(tr, "[tool call look]") {
		t.Fatalf("refused summary receiver got the data: %q", tr[:min(300, len(tr))])
	}
	if tr := run(func() error { return nil }); !strings.Contains(tr, "SECRET") {
		t.Fatal("allowed summary receiver lost the data")
	}
	// 接到 tools.CheckDataSend：查的是 summary 角色
	seen := fakeDataSendCheck(t)
	if tr := run(func() error { return tools.CheckDataSend(context.Background(), nil, "summary") }); strings.Contains(tr, "SECRET") || (*seen)[0] != "summary" {
		t.Fatalf("seen %v", *seen)
	}
}

func TestWithholdLocalDataUnclosed(t *testing.T) {
	s := withholdLocalData(`[1] <command_output trust="untrusted">` + "\nSECRET tail without close")
	if strings.Contains(s, "SECRET") || !strings.HasPrefix(s, `[1] <command_output trust="untrusted">`) {
		t.Fatal(s)
	}
}
