package gwstore

import (
	"reflect"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 供应商排序：按给的顺序；没列出的保持原有相对顺序排在后面，不认识的 id 忽略
func TestReorderProviders(t *testing.T) {
	st := &Store{data: u.NewObj("providers", []any{
		u.NewObj("id", "a"), u.NewObj("id", "b"), u.NewObj("id", "c"), u.NewObj("id", "d"),
	})}
	st.ReorderProviders([]string{"c", "nope", "a", "c"})
	got := []string{}
	for _, p := range st.Providers() {
		got = append(got, p.(*u.Obj).Get("id").(string))
	}
	if want := []string{"c", "a", "b", "d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// 列表上的启用开关：只改 enabled，其它设置不动
func TestSetProviderEnabled(t *testing.T) {
	st := &Store{data: u.NewObj("providers", []any{u.NewObj("id", "a", "enabled", true, "models", []any{"m"})})}
	if !st.SetProviderEnabled("a", false) || st.SetProviderEnabled("nope", true) {
		t.Fatal("return value")
	}
	p := st.Providers()[0].(*u.Obj)
	if p.Get("enabled") != false || len(p.Get("models").([]any)) != 1 {
		t.Fatalf("%v", p)
	}
}
