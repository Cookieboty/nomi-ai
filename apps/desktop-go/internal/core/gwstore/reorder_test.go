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
