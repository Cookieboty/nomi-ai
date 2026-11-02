package delegate

// 对应 tests/unit/cli/intentHint.test.ts（persistent-tasks §7.4）

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

func TestApplyDispatchHintUserChat(t *testing.T) {
	a := map[string]any{"messages": []any{
		map[string]any{"role": "system", "content": "人设"},
		map[string]any{"role": "user", "content": "hi"},
	}}
	if ok, err := ApplyDispatchHint(a); !ok || err != nil {
		t.Fatalf("追加 = %v, %v", ok, err)
	}
	if got := a["messages"].([]any)[0].(map[string]any)["content"]; got != "人设\n\n"+DispatchHint {
		t.Errorf("系统提示 = %q", got)
	}
	b := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	if ok, _ := ApplyDispatchHint(b); !ok {
		t.Fatal("没有系统提示时也要追加")
	}
	msgs := b["messages"].([]any)
	if len(msgs) != 2 || !reflect.DeepEqual(msgs[0], map[string]any{"role": "system", "content": DispatchHint}) {
		t.Errorf("没有系统提示时应插到最前：%v", msgs)
	}
}

func TestApplyDispatchHintSkipsTaskAndCallerTab(t *testing.T) {
	for _, extra := range []map[string]any{{"taskId": "t1"}, {"callerTabId": "tab"}} {
		o := map[string]any{"extra": extra, "messages": []any{map[string]any{"role": "system", "content": "s"}}}
		if ok, err := ApplyDispatchHint(o); ok || err != nil {
			t.Errorf("%v：追加 = %v, %v", extra, ok, err)
		}
		if got := o["messages"].([]any)[0].(map[string]any)["content"]; got != "s" {
			t.Errorf("%v：系统提示被改成 %q", extra, got)
		}
	}
}

func TestDispatchHintCoversRules(t *testing.T) {
	for _, k := range []string{"delegate_to_nomi", "delegate_to_cli", "task_propose", "reminder_create"} {
		if !strings.Contains(DispatchHint, k) {
			t.Errorf("规则缺少 %s", k)
		}
	}
}

// 与 Node intentHint.ts 的 DISPATCH_HINT 逐字一致：从 TS 源码里取出数组的每一行
func TestDispatchHintMatchesNode(t *testing.T) {
	src, err := os.ReadFile(paritytest.RepoPath("apps", "desktop-electron", "internal", "core", "src", "cli", "delegate", "intentHint.ts"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	start := strings.Index(text, "export const DISPATCH_HINT = [\n")
	end := strings.Index(text, "].join('\\n');")
	if start < 0 || end < start {
		t.Fatal("intentHint.ts 里找不到 DISPATCH_HINT 数组")
	}
	var lines []string
	for _, l := range strings.Split(text[start+len("export const DISPATCH_HINT = [\n"):end], "\n") {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		if !strings.HasPrefix(l, "'") || !strings.HasSuffix(l, "',") || strings.ContainsAny(l[1:len(l)-2], `'\`) {
			t.Fatalf("无法解析的行：%s", l)
		}
		lines = append(lines, l[1:len(l)-2])
	}
	if want := strings.Join(lines, "\n"); DispatchHint != want {
		t.Errorf("DispatchHint 与 Node 不一致：\nGo:   %q\nNode: %q", DispatchHint, want)
	}
}
