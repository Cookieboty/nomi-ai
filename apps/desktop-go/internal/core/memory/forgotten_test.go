package memory

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type fakeFacade struct {
	facts     map[string]bool
	summaries map[string]bool
}

func (f *fakeFacade) PutFact(x map[string]any)           { f.facts[x["id"].(string)] = true }
func (f *fakeFacade) DeleteFact(id string) bool          { delete(f.facts, id); return true }
func (f *fakeFacade) PutSummary(x map[string]any)        { f.summaries[x["sessionId"].(string)] = true }
func (f *fakeFacade) DeleteSummary(id string)            { delete(f.summaries, id) }
func (f *fakeFacade) Profile() any                       { return nil }
func (f *fakeFacade) ResetProfile(context.Context) error { return nil }

func turns(n int, text string) []TurnMsg {
	out := []TurnMsg{}
	for i := 0; i < n; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		out = append(out, TurnMsg{Role: role, Content: text + " " + strconv.Itoa(i)})
	}
	return out
}

// 删一段情景摘要：提炼出的事实一起删；之后再提炼同一段对话找不回来，只看删除之后的新消息
func TestRemoveEpisodeForgetsDerivedFacts(t *testing.T) {
	fc := &fakeFacade{facts: map[string]bool{}, summaries: map[string]bool{}}
	var seen []string
	n := 0
	s := New(Deps{Root: t.TempDir(), Facade: func() Facade { return fc },
		NewID: func() string { n++; return "id" + strconv.Itoa(n) },
		Complete: func(_ context.Context, msgs []deps.Msg) (string, error) {
			seen = append(seen, msgs[len(msgs)-1].Content)
			return `{"title":"t","summary":"聊了养猫","keywords":["猫"],"facts":[{"kind":"preference","text":"用户喜欢养猫"}]}`, nil
		}})
	ctx := context.Background()
	if _, err := s.Ingest(ctx, "c1", turns(6, "old"), true); err != nil {
		t.Fatal(err)
	}
	// 用户自己写的事实不受摘要删除影响
	if _, err := s.UpsertFact(ctx, map[string]any{"text": "用户住在杭州", "kind": "fact"}); err != nil {
		t.Fatal(err)
	}
	l := s.List("")
	if len(l.Episodes) != 1 || len(l.Facts) != 2 || !fc.summaries["c1"] {
		t.Fatalf("setup: %d episodes %d facts", len(l.Episodes), len(l.Facts))
	}
	if !s.Remove("episode", l.Episodes[0].ID) {
		t.Fatal("remove")
	}
	l = s.List("")
	if len(l.Episodes) != 0 || len(l.Facts) != 1 || l.Facts[0].Text != "用户住在杭州" {
		t.Fatalf("derived facts kept: %+v", l.Facts)
	}
	if fc.summaries["c1"] || len(fc.facts) != 1 {
		t.Fatalf("facade not cleaned: %v %v", fc.summaries, fc.facts)
	}
	// 同一段对话再提炼：旧消息不再交给模型；新消息不够就不提炼
	seen = nil
	if r, _ := s.Ingest(ctx, "c1", turns(6, "old"), true); r.Skipped != "too-short" || len(seen) != 0 {
		t.Fatalf("re-summarized old messages: %+v %v", r, seen)
	}
	// 有了新消息：只看新的；模型又提炼出「喜欢养猫」也不加回
	all := append(turns(6, "old"), turns(4, "new")...)
	if _, err := s.Ingest(ctx, "c1", all, true); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || strings.Contains(seen[0], "old ") || !strings.Contains(seen[0], "new ") {
		t.Fatalf("summary input: %v", seen)
	}
	for _, f := range s.List("").Facts {
		if strings.Contains(f.Text, "养猫") {
			t.Fatal("forgotten fact came back")
		}
	}
	// 用户自己再写一遍：以用户为准
	if _, err := s.UpsertFact(ctx, map[string]any{"text": "用户喜欢养猫", "kind": "preference"}); err != nil {
		t.Fatal(err)
	}
	if s.data.Forgotten.hasFact("用户喜欢养猫") {
		t.Fatal("user-written fact still forgotten")
	}
	// 重新加载后仍然记得哪些被删过
	s.Flush()
	s2 := New(Deps{Root: s.d.Root})
	if s2.data.Forgotten.Conversations["c1"] != 6 {
		t.Fatalf("not persisted: %+v", s2.data.Forgotten)
	}
}

// 删一条事实：之后提炼出近似重复的不再加回
func TestRemoveFactIsNotReextracted(t *testing.T) {
	n := 0
	s := New(Deps{Root: t.TempDir(), NewID: func() string { n++; return "id" + strconv.Itoa(n) },
		Complete: func(context.Context, []deps.Msg) (string, error) {
			return `{"title":"t","summary":"s","keywords":[],"facts":[{"kind":"preference","text":"用户喜欢养猫"}]}`, nil
		}})
	ctx := context.Background()
	_, _ = s.Ingest(ctx, "c1", turns(6, "a"), true)
	f := s.List("").Facts
	if len(f) != 1 || !s.Remove("fact", f[0].ID) {
		t.Fatal("setup")
	}
	_, _ = s.Ingest(ctx, "c1", append(turns(6, "a"), turns(4, "b")...), true)
	if len(s.List("").Facts) != 0 {
		t.Fatal("deleted fact re-extracted")
	}
}
