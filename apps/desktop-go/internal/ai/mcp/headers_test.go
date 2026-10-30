package mcp

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// #202：x-mcp-header 的 string 绑定拿到数字 / 布尔 / 数组 / 对象时返回 TypeError，不能 panic
// （工具在单独的协程里执行，panic 没人接，整个后端会退出）
func TestCreateMCPToolHeadersStringBindingWrongType(t *testing.T) {
	b := []headerBinding{{headerName: "Text", path: []string{"text"}, valueType: "string"}}
	for _, v := range []any{1.0, true, []any{"a"}, u.NewObj("a", "b")} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("%T: panic %v", v, r)
				}
			}()
			_, err := createMCPToolHeaders(b, u.NewObj("text", v))
			je, ok := err.(*JSError)
			if !ok || je.Name != "TypeError" {
				t.Fatalf("%T: want TypeError, got %v", v, err)
			}
		}()
	}
	// 正常字符串（含 Unicode）照常编码；缺失 / null 跳过
	got, err := createMCPToolHeaders(b, u.NewObj("text", "你好"))
	if err != nil || len(got) != 1 || got[0][0] != "Mcp-Param-Text" || got[0][1] != EncodeMCPHeaderValue("你好") {
		t.Fatalf("string: %v %v", got, err)
	}
	for _, args := range []*u.Obj{u.NewObj(), u.NewObj("text", nil)} {
		if got, err := createMCPToolHeaders(b, args); err != nil || len(got) != 0 {
			t.Fatalf("missing/null: %v %v", got, err)
		}
	}
}
