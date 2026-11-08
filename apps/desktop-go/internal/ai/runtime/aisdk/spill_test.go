package aisdk

import (
	"context"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func toolByName(ts []Tool, name string) *Tool {
	for i := range ts {
		if ts[i].Name == name {
			return &ts[i]
		}
	}
	return nil
}

// 大段输出：模型只看开头和结尾，用 tool_output_read 分页读；外发保护的标记每一段都在；别的对话读不到
func TestSpillLargeToolOutput(t *testing.T) {
	body := "BEGIN" + strings.Repeat("x", 50_000) + "MIDDLE" + strings.Repeat("y", 20_000) + "END"
	big := "<file_content path=\"/w/a.log\" trust=\"untrusted\">\n" + body + "\n</file_content>"
	p := &Provider{ID: "p"}
	defs := []tools.Definition{
		{Name: "fs_read_text", Execute: func(context.Context, any, tools.ExecContext) (any, error) { return u.NewObj("text", big), nil }},
		{Name: "image_generate", Execute: func(context.Context, any, tools.ExecContext) (any, error) { return big, nil }},
	}
	ts := p.toolsFor(defs, &llm.ChatRequest{Messages: []llm.ChatMessage{{Role: "user", Content: "q"}}, Extra: map[string]any{"conversationId": "c1"}})
	out, _ := toolByName(ts, "fs_read_text").Execute(context.Background(), u.NewObj(), "t1")
	s, ok := out.(string)
	if !ok || len([]rune(s)) > 12_000 || strings.Contains(s, "MIDDLE") || !strings.Contains(s, "END") || !strings.Contains(s, OutputReadTool) {
		t.Fatalf("preview: %T %d", out, len([]rune(s)))
	}
	// 开头和结尾两段各自包在标记里（开头那段本身还带着原输出的标记）
	parts := strings.SplitN(s, "…[output too long", 2)
	if !strings.HasPrefix(parts[0], "<file_content") || !strings.Contains(parts[1], "<file_content") {
		t.Fatal("each preview part must keep the guard tag")
	}
	id := s[strings.Index(s, `id="`)+4:]
	id = id[:strings.Index(id, `"`)]
	read := toolByName(ts, OutputReadTool)
	page, err := read.Execute(context.Background(), u.NewObj("id", id, "offset", float64(strings.Index(u.Stringify(u.NewObj("text", big)), "MIDDLE")), "limit", float64(100)), "t2")
	if err != nil || !strings.Contains(page.(string), "MIDDLE") || !strings.Contains(page.(string), "<file_content") {
		t.Fatalf("page: %v %v", page, err)
	}
	// 别的对话：读不到
	other := p.toolsFor(defs, &llm.ChatRequest{Messages: []llm.ChatMessage{{Role: "user", Content: "q"}}, Extra: map[string]any{"conversationId": "c2"}})
	if _, err := toolByName(other, OutputReadTool).Execute(context.Background(), u.NewObj("id", id), "t3"); err == nil {
		t.Fatal("another conversation read the output")
	}
	// 视图要解析结构的工具：不暂存
	if raw, _ := toolByName(ts, "image_generate").Execute(context.Background(), u.NewObj(), "t4"); raw != big {
		t.Fatal("image_generate output must stay as is")
	}
	// 小输出：原样
	if spillOutput("fs_read_text", "c1", "short") != "short" {
		t.Fatal("small output changed")
	}
}
