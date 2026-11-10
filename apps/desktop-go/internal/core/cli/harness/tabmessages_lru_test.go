package harness

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 内存里只留最近读过的 MaxCachedTabMessages 个标签的消息；回收的从文件读回，内容不丢
func TestTabMessagesCacheIsBounded(t *testing.T) {
	o := titleTestOrch(t)
	var ids []string
	jsrt.Run(func() {
		for i := 0; i < MaxCachedTabMessages+3; i++ {
			tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
			id, _ := tab.Get("id").(string)
			ids = append(ids, id)
			o.appendMessage(id, util.NewObj("id", "m"+id, "role", "user", "content", "hi "+id))
		}
	})
	jsrt.Run(func() { o.FlushPersist() })
	// 写完盘后逐个读一遍，触发回收（回收排在下一轮）
	jsrt.Run(func() {
		for _, id := range ids {
			_ = o.TabMessages(id)
		}
	})
	time.Sleep(30 * time.Millisecond)
	jsrt.Run(func() {
		if n := len(o.messages); n > MaxCachedTabMessages {
			t.Fatalf("cached %d tabs, want <= %d", n, MaxCachedTabMessages)
		}
		if _, ok := o.messages[ids[0]]; ok {
			t.Fatal("least recently read tab should be evicted")
		}
		if _, ok := o.messages[ids[len(ids)-1]]; !ok {
			t.Fatal("most recent tab should stay cached")
		}
		// 被回收的标签：排一次写盘也不能把文件写成空列表
		o.persistMessages(ids[0])
		o.FlushPersist()
		got := o.TabMessages(ids[0])
		if len(got) != 1 || got[0].Get("content") != "hi "+ids[0] {
			t.Fatalf("evicted tab reload: %v", got)
		}
	})
}
