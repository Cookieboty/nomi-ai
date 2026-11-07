package desktop

import (
	"strings"
	"testing"
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
