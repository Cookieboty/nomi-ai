package memory

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// 同一会话里已经带给模型的记忆不再重复召回（前缀不变）；返回的 ids 覆盖 text 里的全部条目
func TestContextExcludingSkipsInjected(t *testing.T) {
	s := New(Deps{Root: t.TempDir()})
	s.settings = DefaultSettings
	s.data.Facts = []Fact{
		{ID: "f1", Kind: "identity", Text: "用户叫小明"},
		{ID: "f2", Kind: "identity", Text: "用户住在杭州"},
	}
	if _, err := s.SetPersona("我是前端工程师"); err != nil {
		t.Fatal(err)
	}
	all := s.ContextExcluding(context.Background(), "你好", nil)
	pid := ProfileID("我是前端工程师")
	if !slices.Equal(all.IDs, []string{pid, "f1", "f2"}) {
		t.Fatalf("ids %v", all.IDs)
	}
	for _, want := range []string{"前端工程师", "小明", "杭州"} {
		if !strings.Contains(all.Text, want) {
			t.Fatalf("missing %s in %s", want, all.Text)
		}
	}
	part := s.ContextExcluding(context.Background(), "你好", []string{pid, "f1"})
	if !slices.Equal(part.IDs, []string{"f2"}) || strings.Contains(part.Text, "小明") || strings.Contains(part.Text, "前端工程师") {
		t.Fatalf("partial %v %q", part.IDs, part.Text)
	}
	none := s.ContextExcluding(context.Background(), "你好", all.IDs)
	if none.Text != "" || len(none.IDs) != 0 || len(none.Used) != 0 {
		t.Fatalf("all excluded %+v", none)
	}
	// 改了档案：标记跟着变，会重新带上
	if _, err := s.SetPersona("我是后端工程师"); err != nil {
		t.Fatal(err)
	}
	if again := s.ContextExcluding(context.Background(), "你好", all.IDs); !strings.Contains(again.Text, "后端工程师") {
		t.Fatalf("edited profile should come back: %q", again.Text)
	}
}
