package igtools

import (
	"context"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func planIn(items ...[2]string) *u.Obj {
	arr := []any{}
	for _, it := range items {
		arr = append(arr, u.NewObj("step", it[0], "status", it[1]))
	}
	return u.NewObj("items", arr)
}

func TestPlanUpdate(t *testing.T) {
	d := PlanTool()
	out, err := d.Execute(context.Background(), planIn([2]string{"读代码", "done"}, [2]string{"改  接口", "in_progress"}, [2]string{"跑测试", "pending"}), tools.ExecContext{})
	if err != nil {
		t.Fatal(err)
	}
	s := out.(string)
	for _, want := range []string{"（1/3 完成）", "[x] 1. 读代码", "[>] 2. 改 接口", "[ ] 3. 跑测试", "全部完成前不要收尾"} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
	out, _ = d.Execute(context.Background(), planIn([2]string{"a", "done"}, [2]string{"b", "skipped"}), tools.ExecContext{})
	if !strings.Contains(out.(string), "全部完成") {
		t.Fatal(out)
	}
	if _, err := d.Execute(context.Background(), planIn([2]string{"a", "maybe"}), tools.ExecContext{}); err == nil {
		t.Fatal("bad status")
	}
	if _, err := d.Execute(context.Background(), u.NewObj(), tools.ExecContext{}); err == nil {
		t.Fatal("missing items")
	}
	if !tools.IsRelevant(d, tools.Turn{Cwd: "/w"}) || tools.IsRelevant(d, tools.Turn{ConvoText: "今天天气"}) {
		t.Fatal("gate")
	}
}
