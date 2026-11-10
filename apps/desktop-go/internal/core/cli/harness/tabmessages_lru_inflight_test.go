package harness

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func msgTexts(list []*util.Obj) []string {
	out := make([]string, 0, len(list))
	for _, m := range list {
		if m == nil {
			continue
		}
		if s, ok := m.Get("content").(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func waitFlush(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	if ch == nil {
		t.Fatal("no flush")
	}
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("flush timed out")
	}
}

// holdCommit blocks the matching file's rename until release. The hook runs
// after the snapshot is inflight and before the generation check.
func holdCommit(t *testing.T, o *Orchestrator, file string) (reached <-chan struct{}, release func()) {
	t.Helper()
	hit := make(chan struct{})
	hold := make(chan struct{})
	var once sync.Once
	o.writer.SetCommitHook(func(path string) error {
		if path != file {
			return nil
		}
		once.Do(func() { close(hit) })
		<-hold
		return nil
	})
	var rel sync.Once
	return hit, func() { rel.Do(func() { close(hold) }) }
}

func cacheTabs(t *testing.T, n int) (*Orchestrator, []string) {
	t.Helper()
	o := titleTestOrch(t)
	var ids []string
	jsrt.Run(func() {
		for i := 0; i < n; i++ {
			tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
			id, _ := tab.Get("id").(string)
			ids = append(ids, id)
			o.appendMessage(id, util.NewObj("id", "m"+id, "role", "user", "content", "base "+id))
		}
		o.FlushPersist()
	})
	return o, ids
}

func TestEvictSkipsInflightTabMessages(t *testing.T) {
	o, ids := cacheTabs(t, MaxCachedTabMessages+1)
	target := ids[0]
	path := o.messagesPath(target)
	reached, release := holdCommit(t, o, path)
	defer func() {
		release()
		o.writer.SetCommitHook(nil)
		jsrt.Run(o.Dispose)
	}()

	var first, second <-chan struct{}
	jsrt.Run(func() {
		o.appendMessage(target, util.NewObj("id", "new", "role", "user", "content", "new"))
		first = o.writer.Flush()
	})
	<-reached
	jsrt.Run(func() {
		if o.writer.Has(path) {
			t.Fatal("flushed write still pending")
		}
		if !o.writer.HasUncommitted(path) {
			t.Fatal("inflight write was invisible to eviction")
		}
		disk := msgTexts(o.readMessagesFile(target))
		if len(disk) != 1 || disk[0] != "base "+target {
			t.Fatalf("rename already happened: %v", disk)
		}
		for _, id := range ids[1:] {
			_ = o.TabMessages(id)
		}
		o.evictTabMessages()
		if _, ok := o.messages[target]; !ok {
			t.Fatal("evicted a tab whose write had not been renamed")
		}
		if got := msgTexts(o.messages[target]); len(got) != 2 || got[1] != "new" {
			t.Fatalf("memory during inflight: %v", got)
		}
		// A reload now would otherwise read the old file and the next save would drop "new".
		o.appendMessage(target, util.NewObj("id", "newer", "role", "user", "content", "newer"))
		second = o.writer.Flush()
	})
	release()
	waitFlush(t, first)
	waitFlush(t, second)
	jsrt.Run(func() {
		if o.writer.HasUncommitted(path) {
			t.Fatal("committed write still uncommitted")
		}
		got := msgTexts(o.readMessagesFile(target))
		if len(got) != 3 || got[0] != "base "+target || got[1] != "new" || got[2] != "newer" {
			t.Fatalf("disk after both commits: %v", got)
		}
		for _, id := range ids[1:] {
			_ = o.TabMessages(id)
		}
		o.evictTabMessages()
		if _, ok := o.messages[target]; ok {
			t.Fatal("committed idle tab should be evictable")
		}
		reloaded := msgTexts(o.TabMessages(target))
		if len(reloaded) != 3 || reloaded[2] != "newer" {
			t.Fatalf("reload after eviction: %v", reloaded)
		}
	})
	if tmp, _ := filepath.Glob(filepath.Join(o.tabsDir, "*.tmp")); len(tmp) != 0 {
		t.Fatalf("temp files left: %v", tmp)
	}
}

func TestEvictSkipsInflightWhenMessageFileMissing(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	var others []string
	var target, path string
	jsrt.Run(func() {
		for i := 0; i < MaxCachedTabMessages; i++ {
			tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
			id, _ := tab.Get("id").(string)
			others = append(others, id)
			o.appendMessage(id, util.NewObj("id", "m"+id, "role", "user", "content", "base "+id))
		}
		o.FlushPersist()
		tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
		target, _ = tab.Get("id").(string)
		path = o.messagesPath(target)
	})
	reached, release := holdCommit(t, o, path)
	defer func() {
		release()
		o.writer.SetCommitHook(nil)
	}()
	var flush <-chan struct{}
	jsrt.Run(func() {
		o.appendMessage(target, util.NewObj("id", "first", "role", "user", "content", "first"))
		flush = o.writer.Flush()
	})
	<-reached
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file exists before rename: %v", err)
	}
	var second <-chan struct{}
	jsrt.Run(func() {
		for _, id := range others {
			_ = o.TabMessages(id)
		}
		o.evictTabMessages()
		if _, ok := o.messages[target]; !ok {
			t.Fatal("evicted the tab before its first file existed")
		}
		o.appendMessage(target, util.NewObj("id", "second", "role", "user", "content", "second"))
		second = o.writer.Flush()
	})
	release()
	waitFlush(t, flush)
	waitFlush(t, second)
	jsrt.Run(func() {
		got := msgTexts(o.readMessagesFile(target))
		if len(got) != 2 || got[0] != "first" || got[1] != "second" {
			t.Fatalf("first file: %v", got)
		}
	})
}

func TestStaleInflightWriteDoesNotResurrectMessages(t *testing.T) {
	o, ids := cacheTabs(t, 1)
	defer jsrt.Run(o.Dispose)
	target := ids[0]
	path := o.messagesPath(target)
	reached, release := holdCommit(t, o, path)
	defer func() {
		release()
		o.writer.SetCommitHook(nil)
	}()
	var first, second <-chan struct{}
	jsrt.Run(func() {
		o.appendMessage(target, util.NewObj("id", "doomed", "role", "user", "content", "doomed"))
		first = o.writer.Flush()
	})
	<-reached
	jsrt.Run(func() {
		list := o.messages[target]
		o.messages[target] = list[:len(list)-1]
		o.appendMessage(target, util.NewObj("id", "kept", "role", "user", "content", "kept"))
		second = o.writer.Flush()
	})
	release()
	waitFlush(t, first)
	waitFlush(t, second)
	jsrt.Run(func() {
		got := msgTexts(o.readMessagesFile(target))
		if len(got) != 2 || got[1] != "kept" {
			t.Fatalf("stale generation resurrected messages: %v", got)
		}
		for _, text := range got {
			if text == "doomed" {
				t.Fatal("doomed message landed")
			}
		}
	})
}

func TestFailedCommitStaysUncommittedUntilFlushSync(t *testing.T) {
	o, ids := cacheTabs(t, MaxCachedTabMessages+1)
	defer jsrt.Run(o.Dispose)
	target := ids[0]
	path := o.messagesPath(target)
	o.writer.SetCommitHook(func(file string) error {
		if file == path {
			return errors.New("disk full")
		}
		return nil
	})
	defer o.writer.SetCommitHook(nil)
	var flush <-chan struct{}
	jsrt.Run(func() {
		o.appendMessage(target, util.NewObj("id", "new", "role", "user", "content", "new"))
		flush = o.writer.Flush()
	})
	waitFlush(t, flush)
	jsrt.Run(func() {
		if !o.writer.HasUncommitted(path) {
			t.Fatal("failed commit cleared the snapshot")
		}
		for _, id := range ids[1:] {
			_ = o.TabMessages(id)
		}
		o.evictTabMessages()
		if _, ok := o.messages[target]; !ok {
			t.Fatal("evicted a tab whose write failed")
		}
		disk := msgTexts(o.readMessagesFile(target))
		if len(disk) != 1 {
			t.Fatalf("failed commit changed the file: %v", disk)
		}
		o.writer.SetCommitHook(nil)
		o.FlushPersist()
		if o.writer.HasUncommitted(path) {
			t.Fatal("FlushSync left the snapshot inflight")
		}
		got := msgTexts(o.readMessagesFile(target))
		if len(got) != 2 || got[1] != "new" {
			t.Fatalf("retry: %v", got)
		}
	})
}

func TestCancelDuringInflightDoesNotResurrectFile(t *testing.T) {
	o, ids := cacheTabs(t, 1)
	defer jsrt.Run(o.Dispose)
	target := ids[0]
	path := o.messagesPath(target)
	reached, release := holdCommit(t, o, path)
	defer func() {
		release()
		o.writer.SetCommitHook(nil)
	}()
	var flush <-chan struct{}
	jsrt.Run(func() {
		o.appendMessage(target, util.NewObj("id", "new", "role", "user", "content", "new"))
		flush = o.writer.Flush()
	})
	<-reached
	jsrt.Run(func() { o.CloseTab(target) })
	release()
	waitFlush(t, flush)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cancelled write recreated %s: %v", path, err)
	}
}

func TestEvictStillKeepsActiveBusyAndRecentTabs(t *testing.T) {
	o, ids := cacheTabs(t, MaxCachedTabMessages+1)
	defer jsrt.Run(o.Dispose)
	oldest := ids[0]
	jsrt.Run(func() {
		for _, id := range ids {
			_ = o.TabMessages(id)
		}
		o.tab(oldest).Set("status", "running")
		o.evictTabMessages()
		if _, ok := o.messages[oldest]; !ok {
			t.Fatal("evicted a running tab")
		}
		o.tab(oldest).Set("status", "idle")
		o.activeTabID = oldest
		for _, id := range ids[1:] {
			_ = o.TabMessages(id)
		}
		o.evictTabMessages()
		if _, ok := o.messages[oldest]; !ok {
			t.Fatal("evicted the active tab")
		}
		o.activeTabID = MainTabID
		for _, id := range ids[1:] {
			_ = o.TabMessages(id)
		}
		o.evictTabMessages()
		if _, ok := o.messages[oldest]; ok {
			t.Fatal("idle inactive tab should leave the cache")
		}
		if _, ok := o.messages[ids[len(ids)-1]]; !ok {
			t.Fatal("most recently read tab was evicted")
		}
	})
}
