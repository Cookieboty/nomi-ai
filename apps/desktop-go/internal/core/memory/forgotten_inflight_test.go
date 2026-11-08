package memory

// 删除 / 清空时在途的摘要（Ingest 等模型、等向量时不持锁）：删除之前读到的旧内容不能再写回（#289）

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type gate struct{ entered, release chan struct{} }

func newGate() *gate { return &gate{make(chan struct{}), make(chan struct{})} }

// wait：通知测试已经走到这里，等测试放行
func (g *gate) wait() { g.entered <- struct{}{}; <-g.release }

func hasText(l ListResult, sub string) bool {
	for _, f := range l.Facts {
		if strings.Contains(f.Text, sub) {
			return true
		}
	}
	for _, e := range l.Episodes {
		if strings.Contains(e.Summary, sub) {
			return true
		}
	}
	return false
}

// 已有摘要 E 的更新在等模型 / 等向量时用户删掉 E：这次的摘要和事实整批丢弃，门面里也没有
func TestRemoveEpisodeDiscardsInflightIngest(t *testing.T) {
	for _, at := range []string{"complete", "embed"} {
		t.Run(at, func(t *testing.T) {
			fc := &fakeFacade{facts: map[string]bool{}, summaries: map[string]bool{}}
			n, calls := 0, 0
			var g *gate
			s := New(Deps{Root: t.TempDir(), Facade: func() Facade { return fc },
				NewID: func() string { n++; return "id" + strconv.Itoa(n) },
				Complete: func(context.Context, []deps.Msg) (string, error) {
					calls++
					if calls == 1 {
						return `{"title":"t","summary":"聊了养猫","keywords":[],"facts":[{"kind":"preference","text":"用户喜欢养猫"}]}`, nil
					}
					if at == "complete" && g != nil {
						g.wait()
					}
					return `{"title":"t","summary":"聊了旧房子","keywords":[],"facts":[{"kind":"fact","text":"用户以前住在成都"}]}`, nil
				},
				Embed: func(_ context.Context, texts []string) ([][]float32, error) {
					if at == "embed" && g != nil {
						g.wait()
					}
					return nil, nil
				}})
			ctx := context.Background()
			if _, err := s.Ingest(ctx, "c1", turns(6, "old"), true); err != nil {
				t.Fatal(err)
			}
			epID := s.List("").Episodes[0].ID
			g = newGate()
			done := make(chan IngestResult)
			go func() {
				r, _ := s.Ingest(ctx, "c1", append(turns(6, "old"), turns(4, "more")...), true)
				done <- r
			}()
			<-g.entered
			if !s.Remove("episode", epID) {
				t.Fatal("remove")
			}
			close(g.release)
			r := <-done
			l := s.List("")
			if r.Skipped != "forgotten" || len(l.Episodes) != 0 || len(l.Facts) != 0 || hasText(l, "成都") || len(fc.facts) != 0 || fc.summaries["c1"] {
				t.Fatalf("stale ingest written: %+v episodes %d facts %+v facade %v %v", r, len(l.Episodes), l.Facts, fc.facts, fc.summaries)
			}
			// 删除之后的新消息照常提炼
			g = nil
			if res, err := s.Ingest(ctx, "c1", append(append(turns(6, "old"), turns(4, "more")...), turns(4, "new")...), true); err != nil || res.Episode == nil {
				t.Fatalf("after delete: %+v %v", res, err)
			}
		})
	}
}

// 对话第一次摘要在等模型时清空全部：放行后仍然是空的
func TestClearAllDiscardsInflightFirstIngest(t *testing.T) {
	g := newGate()
	s := New(Deps{Root: t.TempDir(),
		Complete: func(context.Context, []deps.Msg) (string, error) {
			g.wait()
			return `{"title":"t","summary":"聊了养猫","keywords":[],"facts":[{"kind":"preference","text":"用户喜欢养猫"}]}`, nil
		}})
	done := make(chan IngestResult)
	go func() {
		r, _ := s.Ingest(context.Background(), "c9", turns(6, "x"), true)
		done <- r
	}()
	<-g.entered
	s.ClearAll()
	close(g.release)
	if r := <-done; r.Skipped != "forgotten" {
		t.Fatalf("result %+v", r)
	}
	if l := s.List(""); len(l.Episodes) != 0 || len(l.Facts) != 0 {
		t.Fatalf("cleared memory came back: %+v", l)
	}
}

// 等向量期间用户删掉了一条同文事实：不加回
func TestRemoveFactDuringEmbedNotReadded(t *testing.T) {
	n := 0
	var g *gate
	s := New(Deps{Root: t.TempDir(), NewID: func() string { n++; return "id" + strconv.Itoa(n) },
		Complete: func(context.Context, []deps.Msg) (string, error) {
			return `{"title":"t","summary":"s","keywords":[],"facts":[{"kind":"preference","text":"用户喜欢养猫"}]}`, nil
		},
		Embed: func(context.Context, []string) ([][]float32, error) {
			if g != nil {
				g.wait()
			}
			return nil, nil
		}})
	ctx := context.Background()
	if _, err := s.UpsertFact(ctx, map[string]any{"text": "用户喜欢狗", "kind": "preference"}); err != nil {
		t.Fatal(err)
	}
	g = newGate()
	done := make(chan struct{})
	go func() { _, _ = s.Ingest(ctx, "c1", turns(6, "a"), true); close(done) }()
	<-g.entered
	// 模拟用户先前写过、此刻删掉的同文事实
	s.mu.Lock()
	s.data.Forgotten.addFact("用户喜欢养猫")
	s.mu.Unlock()
	close(g.release)
	<-done
	if hasText(s.List(""), "养猫") {
		t.Fatal("fact deleted during embedding came back")
	}
}
