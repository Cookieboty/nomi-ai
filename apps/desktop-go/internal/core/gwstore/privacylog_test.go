package gwstore

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// #164：清空之前拍下的快照不能在清空写盘之后才落盘（把旧记录写回去）
func TestPrivacyLogClearIsNotOverwrittenByEarlierSnapshot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "privacy-log.json")
	l := NewPrivacyLog(file, func() float64 { return 1 })
	l.Note(u.NewObj("client", "claude", "redactions", []any{u.NewObj("placeholder", "<KEY_1>", "kind", "key", "masked", 1.0)}))

	reached, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	afterPrivacySnapshot = func() {
		if first.CompareAndSwap(false, true) { // 只卡第一次：带旧记录的快照拍好后停在写盘之前
			close(reached)
			<-release
		}
	}
	t.Cleanup(func() { afterPrivacySnapshot = func() {} })

	flushed, cleared := make(chan struct{}), make(chan struct{})
	go func() { l.Flush(); close(flushed) }()
	<-reached
	go func() { l.Clear(); close(cleared) }()
	time.Sleep(100 * time.Millisecond) // 给 Clear 抢先写盘的机会（修复前它会先写完）
	close(release)
	<-flushed
	<-cleared

	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "[]" {
		t.Fatalf("after clear the file must be empty, got %s", b)
	}
}
